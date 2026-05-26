import {
  createPageClient,
  discoverLiepinPages,
  isLiepinRiskPageUrl
} from "../chrome.js";
import {
  DEFAULT_DEBUG_PORT,
  DEFAULT_ROBUSTNESS_MODE,
  DEFAULT_RECOMMEND_STEP_DELAY_MS,
  ROBUSTNESS_MODES,
  RUN_WORKFLOWS
} from "../constants.js";
import { classifyLongRunFailure } from "../long-run-runtime.js";
import { runStructuredScreening, SCREENING_MODES } from "../llm-adapter.js";
import { normalizeText, sleep } from "../utils.js";
import { auditCvPayloadCoverage, buildCvScreeningInput } from "./cv-payload.js";
import { COMMUNICATION_QUOTA_EXHAUSTED_STATUS } from "./chat-card-limit.js";
import { extractRecommendCandidateIdentity } from "./recommend-action.js";
import {
  applySearchQuickProfile,
  clickSearchNextPage,
  closeSearchModalToList,
  executeSearchChatAction,
  openSearchCardByIndex,
  prepareSearchJobSelection,
  readSearchListState,
  readSearchModalSnapshot,
  setSearchHideReadFilter,
  waitForSearchPaginationState,
  waitForSearchCards
} from "./search-action.js";

export const SEARCH_CHAT_CHAIN_SCHEMA_VERSION = "liepin_search_chat_chain_v1";
export const SEARCH_CHAT_CHAIN_CHECKPOINT_SCHEMA_VERSION = "liepin_search_chat_chain_checkpoint_v1";
const MAX_CONSECUTIVE_SEARCH_OPEN_RECOVERIES = 3;
const MAX_TOTAL_SEARCH_OPEN_RECOVERIES = 25;

export async function runSearchChatChain({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  candidateLimit = 5,
  scanLimit = null,
  profile = null,
  jobTitle = null,
  hideRead = false,
  startIndex = 0,
  stepDelayMs = DEFAULT_RECOMMEND_STEP_DELAY_MS,
  maxPayloadChars = null,
  criteria = null,
  operatorFilter = null,
  config = null,
  provider = null,
  checkpoint = null,
  onCheckpoint = null,
  onSafeControlPoint = null,
  onProgress = null,
  robustnessMode = DEFAULT_ROBUSTNESS_MODE
} = {}) {
  const requestedProfile = normalizeText(profile);
  const requestedJobTitle = normalizeText(jobTitle);
  const requestedHideRead = Boolean(hideRead);
  if (!requestedProfile) throw new Error("search_chat_chain 需要 profile，请先调用 liepin_search_options 让用户选择。");
  if (!requestedJobTitle) throw new Error("search_chat_chain 需要 job，请先调用 liepin_search_options 让用户选择开聊职位。");

  const requestedCandidateLimit = Math.max(1, candidateLimit);
  const requestedScanLimit = scanLimit
    ? Math.max(requestedCandidateLimit, scanLimit)
    : null;
  const restoredCheckpoint = normalizeSearchCheckpoint(checkpoint, {
    profile: requestedProfile,
    jobTitle: requestedJobTitle,
    hideRead: requestedHideRead
  });
  const recoverEnabled = normalizeText(robustnessMode) === ROBUSTNESS_MODES.RECOVER;
  const items = restoredCheckpoint?.items ? [...restoredCheckpoint.items] : [];
  const recoveries = restoredCheckpoint?.recoveries ? [...restoredCheckpoint.recoveries] : [];
  const seenTextHashes = new Set([
    ...(restoredCheckpoint?.seenTextHashes || []),
    ...items.map((item) => item.textHash).filter(Boolean)
  ]);
  const violations = restoredCheckpoint?.violations ? [...restoredCheckpoint.violations] : [];
  let llmCalls = restoredCheckpoint?.llmCalls ?? items.filter((item) => item.llmCalled).length;
  let communicationClicks = restoredCheckpoint?.communicationClicks ?? items.filter((item) => item.chatAction?.clicked).length;
  let alreadyContactedCandidates = restoredCheckpoint?.alreadyContactedCandidates
    ?? items.filter((item) => item.status === "search_already_contacted").length;
  let passedCandidates = restoredCheckpoint?.passedCandidates
    ?? items.filter((item) => ["search_contacted", "search_already_contacted"].includes(item.status)).length;
  let greetedCandidates = restoredCheckpoint?.greetedCandidates
    ?? countSearchGreetingSentItems(items);
  let communicationQuotaExhausted = Boolean(restoredCheckpoint?.communicationQuotaExhausted);
  let stopReason = restoredCheckpoint?.stopReason || "";
  let currentPageNumber = restoredCheckpoint?.currentPageNumber || 1;
  let pageCardIndex = restoredCheckpoint?.pageCardIndex ?? Math.max(0, startIndex || 0);
  let consecutiveOpenRecoveries = 0;

  const progressState = {
    targetCandidates: requestedCandidateLimit,
    scanLimit: requestedScanLimit,
    profile: requestedProfile,
    jobTitle: requestedJobTitle,
    hideRead: requestedHideRead,
    currentScan: null,
    currentPageNumber,
    currentCardIndex: null,
    scannedCandidates: items.length,
    passedCandidates,
    greetedCandidates,
    llmCalls,
    communicationClicks,
    alreadyContactedCandidates,
    communicationQuotaExhausted,
    stopReason,
    currentCandidateLabel: "",
    lastItem: null
  };
  const buildPartialWorkflowResult = (stage, statusMessage) => {
    const result = buildSearchChatChainResult({
      requestedCandidateLimit,
      requestedScanLimit,
      requestedProfile,
      requestedJobTitle,
      requestedHideRead,
      startIndex,
      stepDelayMs,
      maxPayloadChars,
      llmCalls,
      communicationClicks,
      alreadyContactedCandidates,
      passedCandidates,
      greetedCandidates,
      communicationQuotaExhausted,
      stopReason,
      violations,
      items,
      stage,
      statusMessage,
      passed: false
    });
    return {
      workflow: RUN_WORKFLOWS.SEARCH_CHAT_CHAIN,
      summary: summarizeSearchChatChain(result),
      result
    };
  };
  const emitProgress = (stage, statusMessage, patch = {}) => {
    Object.assign(progressState, patch);
    if (typeof onProgress !== "function") return;
    onProgress({
      stage,
      statusMessage,
      progress: buildSearchChatChainProgressSnapshot(progressState),
      partialResult: buildPartialWorkflowResult(stage, statusMessage)
    });
  };

  const pages = await discoverLiepinPages({ port });
  if (!pages.search && pages.riskPage) {
    throw new Error(`检测到猎聘风控/验证码页，已停止搜索串联：${pages.riskPage.url}`);
  }
  if (!pages.search) {
    throw new Error(`未找到猎聘搜索页，请先在 Chrome ${port} 打开 https://lpt.liepin.com/search`);
  }

  const client = await createPageClient(pages.search);
  try {
    try {
      await assertNotRiskPage(client, "搜索串联");
      emitProgress("prepare_search_page", `已连接搜索页，准备 profile=${requestedProfile} job=${requestedJobTitle} hide_read=${requestedHideRead}`);
      const jobPreparation = await prepareSearchJobSelection(client, {
        jobTitle: requestedJobTitle
      });
      if (!jobPreparation.allUnticked) {
        const violation = {
          code: "search_job_conditions_not_cleared",
          checkedConditions: jobPreparation.clear?.afterChecked || []
        };
        violations.push(violation);
      }
      const profileAction = await applySearchQuickProfile(client, {
        profile: requestedProfile
      });
      const hideReadFilter = await setSearchHideReadFilter(client, {
        hideRead: requestedHideRead
      });
      emitProgress(
        "search_hide_read_filter_confirmed",
        `已确认搜索页“隐藏已查看”：${requestedHideRead ? "已勾选" : "未勾选"}`,
        {
          scannedCandidates: items.length
        }
      );
      await waitForSearchCards(client);
      if (restoredCheckpoint) {
        const restoredPosition = await restoreSearchCheckpointPosition(client, {
          targetPageNumber: currentPageNumber,
          pageCardIndex
        });
        currentPageNumber = restoredPosition.currentPageNumber;
        pageCardIndex = restoredPosition.pageCardIndex;
        emitProgress("search_checkpoint_restored", `已恢复搜索 checkpoint：第 ${currentPageNumber} 页第 ${pageCardIndex + 1} 张卡片`, {
          scannedCandidates: items.length,
          passedCandidates,
          greetedCandidates,
          llmCalls,
          communicationClicks,
          alreadyContactedCandidates,
          currentPageNumber,
          currentCardIndex: pageCardIndex
        });
      }
      emitProgress("search_profile_applied", `已应用搜索 profile：${requestedProfile}`, {
        scannedCandidates: items.length
      });

      while (
        (requestedScanLimit === null || items.length < requestedScanLimit)
        && greetedCandidates < requestedCandidateLimit
        && !communicationQuotaExhausted
      ) {
        await assertNotRiskPage(client, "搜索串联扫描中");
        await waitForSearchCards(client);
        const listState = await readSearchListState(client);
        currentPageNumber = parsePageNumber(listState.activePageText, currentPageNumber);
        if (pageCardIndex >= listState.cardCount) {
          const pagination = await waitForSearchPaginationState(client, { timeoutMs: 7000 });
          if (!pagination.nextExists || pagination.nextDisabled) {
            violations.push({
              code: "search_reached_last_page_before_target",
              scannedCandidates: items.length,
              passedCandidates,
              greetedCandidates,
              requestedCandidateLimit,
              currentPageNumber,
              pageCardIndex,
              listState,
              pagination
            });
            break;
          }
          const nextPage = await clickSearchNextPage(client);
          if (!nextPage.clicked) {
            violations.push({
              code: "search_next_page_not_clicked",
              reason: nextPage.reason || "unknown",
              currentPageNumber,
              pageCardIndex,
              listState,
              pagination: nextPage.before || pagination,
              beforeList: nextPage.beforeList || null
            });
            break;
          }
          currentPageNumber += 1;
          pageCardIndex = 0;
          continue;
        }

        const scanIndex = items.length;
        emitProgress(
          "open_search_candidate",
          `正在处理搜索候选人 ${scanIndex + 1}${requestedScanLimit ? `/${requestedScanLimit}` : ""}`,
          {
          currentScan: scanIndex + 1,
          currentPageNumber,
          currentCardIndex: pageCardIndex,
          currentCandidateLabel: ""
          }
        );
        let openAction = null;
        try {
          openAction = await openSearchCardByIndex(client, pageCardIndex);
          consecutiveOpenRecoveries = 0;
        } catch (error) {
          const recovery = await recoverSearchOpenFailure(error, {
            client,
            recoverEnabled,
            scanIndex,
            currentPageNumber,
            pageCardIndex,
            consecutiveOpenRecoveries,
            recoveryCount: recoveries.length
          });
          if (!recovery.recovered) throw error;
          recoveries.push(recovery);
          if (recovery.openAction) {
            openAction = recovery.openAction;
            consecutiveOpenRecoveries = 0;
          } else {
            consecutiveOpenRecoveries += 1;
            const recoveryItem = {
              index: scanIndex,
              scanIndex,
              pageNumber: currentPageNumber,
              cardIndex: pageCardIndex,
              profile: requestedProfile,
              jobTitle: requestedJobTitle,
              candidate: {},
              llmCalled: false,
              decision: null,
              chatAction: {
                action: "none",
                executed: false,
                clicked: false,
                status: "search_open_recovered_skip"
              },
              status: "search_open_recovered_skip",
              recovery,
              violations: []
            };
            items.push(recoveryItem);
            pageCardIndex += 1;
            emitProgress(
              "search_candidate_recovered",
              `搜索候选人打开失败，已跳过第 ${currentPageNumber} 页第 ${pageCardIndex} 张卡片：${recovery.reason}`,
              {
                currentScan: scanIndex + 1,
                currentPageNumber,
                currentCardIndex: pageCardIndex - 1,
                scannedCandidates: items.length,
                currentCandidateLabel: "",
                lastItem: summarizeSearchChatChainProgressItem(recoveryItem)
              }
            );
            await saveSearchCheckpoint("search_checkpoint", "已保存搜索 recovery checkpoint");
            if (typeof onSafeControlPoint === "function") {
              await onSafeControlPoint(buildPartialWorkflowResult("search_candidate_recovered", "搜索候选人打开失败后已安全跳过"));
            }
            continue;
          }
        }
        await sleep(stepDelayMs);
        await assertNotRiskPage(client, "打开搜索详情后检查");

        let item = null;
        try {
          const snapshot = await readSearchModalSnapshot(client, {
            profile: requestedProfile,
            pageNumber: currentPageNumber,
            cardIndex: pageCardIndex
          });
          const candidate = extractRecommendCandidateIdentity(snapshot);
          const candidateLabel = buildCandidateProgressLabel(candidate, snapshot);
          item = {
            index: scanIndex,
            scanIndex,
            pageNumber: currentPageNumber,
            cardIndex: pageCardIndex,
            profile: requestedProfile,
            jobTitle: requestedJobTitle,
            openAction,
            candidate,
            textHash: snapshot.textHash,
            searchSnapshot: summarizeSearchSnapshot(snapshot),
            llmCalled: false,
            decision: null,
            llmRequest: null,
            inputManifest: null,
            coverage: null,
            chatButtonState: null,
            chatAction: null,
            status: "pending",
            violations: []
          };

          if (seenTextHashes.has(snapshot.textHash)) {
            item.status = "duplicate_search_candidate";
            item.violations.push({
              code: "duplicate_search_candidate",
              textHash: snapshot.textHash
            });
            violations.push({
              code: "duplicate_search_candidate",
              scanIndex,
              textHash: snapshot.textHash
            });
            items.push(item);
            finalizeItemProgress(item);
            continue;
          }
          seenTextHashes.add(snapshot.textHash);

          emitProgress("search_llm", `正在评估搜索候选人：${candidateLabel || `扫描 ${scanIndex + 1}`}`, {
            currentCandidateLabel: candidateLabel
          });
          const screenInput = buildCvScreeningInput(snapshot, { maxPayloadChars });
          const coverage = auditCvPayloadCoverage(snapshot, { maxPayloadChars });
          item.inputManifest = screenInput.manifest;
          item.coverage = coverage;
          if (!coverage.passed) {
            const violation = {
              code: "search_coverage_audit_failed",
              scanIndex,
              textHash: snapshot.textHash,
              coverage
            };
            item.violations.push(violation);
            violations.push(violation);
          }

          const screening = await runStructuredScreening({
            mode: SCREENING_MODES.RECOMMEND,
            screenInput,
            criteria,
            operatorFilters: buildSearchOperatorFilter({
              operatorFilter,
              profile: requestedProfile,
              jobTitle: requestedJobTitle
            }),
            config,
            provider
          });
          llmCalls += 1;
          item.llmCalled = true;
          item.decision = screening.decision;
          item.llmRequest = screening.request;
          item.reasoningCaptured = screening.reasoningCaptured;
          item.reasoningText = screening.reasoningText || "";

          if (!shouldExecuteSearchChat(item.decision)) {
            item.status = item.decision?.decision === "pass"
              ? "search_passed_no_chat_action"
              : "search_rejected";
            item.chatAction = {
              action: "none",
              executed: false,
              clicked: false,
              status: "llm_decision_no_chat"
            };
            items.push(item);
            finalizeItemProgress(item);
            continue;
          }

          item.chatAction = await executeSearchChatAction(client, {
            jobTitle: requestedJobTitle
          });
          if (item.chatAction.quotaExhausted || item.chatAction.status === COMMUNICATION_QUOTA_EXHAUSTED_STATUS) {
            communicationQuotaExhausted = true;
            stopReason = COMMUNICATION_QUOTA_EXHAUSTED_STATUS;
            item.status = COMMUNICATION_QUOTA_EXHAUSTED_STATUS;
            items.push(item);
            finalizeItemProgress(item);
            emitProgress(
              COMMUNICATION_QUOTA_EXHAUSTED_STATUS,
              "检测到购买开聊卡弹窗，沟通次数已达到上限，已停止猎聘搜索任务",
              {
                scannedCandidates: items.length,
                passedCandidates,
                greetedCandidates,
                llmCalls,
                communicationClicks,
                alreadyContactedCandidates,
                stopReason
              }
            );
            break;
          }
          if (item.chatAction.clicked) communicationClicks += 1;
          if (item.chatAction.status === "already_contacted") alreadyContactedCandidates += 1;
          if (item.chatAction.ok) {
            passedCandidates += 1;
            if (item.chatAction.clicked && item.chatAction.status === "search_contacted") {
              greetedCandidates += 1;
            }
            item.status = item.chatAction.status === "already_contacted"
              ? "search_already_contacted"
              : "search_contacted";
          } else {
            const violation = {
              code: "search_chat_action_failed",
              scanIndex,
              status: item.chatAction.status || "unknown",
              reason: item.chatAction.reason || ""
            };
            item.status = "search_chat_action_failed";
            item.violations.push(violation);
            violations.push(violation);
          }
          items.push(item);
          finalizeItemProgress(item);
        } finally {
          const closeAction = await closeSearchModalToList(client, {
            waitForSentGreetingUpsellMs: item?.chatAction?.clicked ? 5000 : 0
          });
          if (item) {
            item.closeAction = closeAction;
            if (!closeAction.closed) {
              const violation = {
                code: "search_modal_not_closed",
                scanIndex,
                pageNumber: currentPageNumber,
                cardIndex: pageCardIndex
              };
              item.violations.push(violation);
              violations.push(violation);
            }
          }
          pageCardIndex += 1;
          if (item && items.includes(item)) {
            await saveSearchCheckpoint("search_checkpoint", "已保存搜索 checkpoint");
            const partialResult = buildPartialWorkflowResult("search_checkpoint", "已保存搜索 checkpoint");
            if (typeof onSafeControlPoint === "function") {
              await onSafeControlPoint(partialResult);
            }
          }
        }
      }

      const result = buildSearchChatChainResult({
        requestedCandidateLimit,
        requestedScanLimit,
        requestedProfile,
        requestedJobTitle,
        requestedHideRead,
        startIndex,
        stepDelayMs,
        maxPayloadChars,
        llmCalls,
        communicationClicks,
        alreadyContactedCandidates,
        passedCandidates,
        greetedCandidates,
        communicationQuotaExhausted,
        stopReason: stopReason || (greetedCandidates >= requestedCandidateLimit ? "candidate_limit_reached" : "completed"),
        violations,
        recoveries,
        items,
        jobPreparation,
        profileAction,
        hideReadFilter
      });
      return {
        ...result,
        passed: evaluateSearchChatChain(result).passed
      };
    } catch (error) {
      if (!error.partialResult) {
        error.partialResult = buildPartialWorkflowResult("failed", error?.message || "Run failed");
      }
      throw error;
    }
  } finally {
    await client.disconnect();
  }

  function finalizeItemProgress(item) {
    emitProgress("candidate_completed", `搜索候选人已完成：${buildCandidateProgressLabel(item.candidate) || item.index + 1} -> ${item.status}`, {
      scannedCandidates: items.length,
      passedCandidates,
      greetedCandidates,
      llmCalls,
      communicationClicks,
      alreadyContactedCandidates,
      currentCandidateLabel: buildCandidateProgressLabel(item.candidate),
      lastItem: summarizeSearchChatChainProgressItem(item)
    });
  }

  async function saveSearchCheckpoint(stage, statusMessage) {
    if (typeof onCheckpoint !== "function") return;
    const checkpointPayload = buildSearchCheckpoint({
      requestedCandidateLimit,
      requestedScanLimit,
      requestedProfile,
      requestedJobTitle,
      requestedHideRead,
      startIndex,
      stepDelayMs,
      maxPayloadChars,
      currentPageNumber,
      pageCardIndex,
      llmCalls,
      communicationClicks,
      alreadyContactedCandidates,
      passedCandidates,
      greetedCandidates,
      communicationQuotaExhausted,
      stopReason,
      seenTextHashes,
      violations,
      recoveries,
      items
    });
    await onCheckpoint(checkpointPayload, buildPartialWorkflowResult(stage, statusMessage));
  }
}

export function evaluateSearchChatChain(result = {}) {
  const failures = Array.isArray(result.violations)
    ? result.violations.map((item) => item?.code || String(item))
    : [];
  const items = Array.isArray(result.items) ? result.items : [];
  if (result.schemaVersion && result.schemaVersion !== SEARCH_CHAT_CHAIN_SCHEMA_VERSION) {
    failures.push("unsupported_schema_version");
  }
  if (!normalizeText(result.profile)) failures.push("missing_search_profile");
  if (!normalizeText(result.jobTitle)) failures.push("missing_job_title");
  const greetedCandidates = Number.isFinite(result.greetedCandidates)
    ? result.greetedCandidates
    : countSearchGreetingSentItems(items);
  if (greetedCandidates < (result.requestedCandidateLimit || 0) && !result.communicationQuotaExhausted) {
    failures.push("not_enough_search_greetings");
  }
  for (const item of items) {
    if (isCommunicationQuotaExhaustedItem(item)) continue;
    if (isSearchOpenRecoveredSkipItem(item)) continue;
    if (!item.llmCalled && item.status !== "duplicate_search_candidate") {
      failures.push(`candidate_${item.index}_llm_not_called`);
    }
    if (shouldExecuteSearchChat(item.decision)) {
      if (!item.chatAction?.ok) failures.push(`candidate_${item.index}_chat_action_not_ok`);
      if (!["search_contacted", "search_already_contacted"].includes(item.status)) {
        failures.push(`candidate_${item.index}_unexpected_status_after_pass`);
      }
    }
    if (item.chatAction?.clicked && item.chatAction.status !== "search_contacted") {
      failures.push(`candidate_${item.index}_unexpected_chat_click_status`);
    }
    if (item.closeAction && !item.closeAction.closed) {
      failures.push(`candidate_${item.index}_modal_not_closed`);
    }
  }
  return {
    passed: dedupeStrings(failures).length === 0,
    failures: dedupeStrings(failures)
  };
}

export function summarizeSearchChatChain(result = {}) {
  const evaluation = evaluateSearchChatChain(result);
  return {
    ok: Boolean(result.passed),
    profile: result.profile || "",
    jobTitle: result.jobTitle || "",
    hideRead: Boolean(result.hideRead),
    hideReadVerified: Boolean(result.hideReadFilter?.verified),
    requestedCandidateLimit: result.requestedCandidateLimit || 0,
    scannedCandidates: result.scannedCandidates || 0,
    passedCandidates: result.passedCandidates || 0,
    greetedCandidates: result.greetedCandidates ?? countSearchGreetingSentItems(result.items || []),
    llmCalls: result.llmCalls || 0,
    communicationClicks: result.communicationClicks || 0,
    alreadyContactedCandidates: result.alreadyContactedCandidates || 0,
    recoveries: Array.isArray(result.recoveries) ? result.recoveries.length : 0,
    actionClicks: result.actionClicks || 0,
    communicationQuotaExhausted: Boolean(result.communicationQuotaExhausted),
    stopReason: result.stopReason || "",
    violations: evaluation.failures
  };
}

export function shouldExecuteSearchChat(decision = {}) {
  return decision?.decision === "pass" && decision?.post_action === "chat";
}

async function recoverSearchOpenFailure(error, {
  client,
  recoverEnabled = false,
  scanIndex,
  currentPageNumber,
  pageCardIndex,
  consecutiveOpenRecoveries = 0,
  recoveryCount = 0
} = {}) {
  const classification = classifyLongRunFailure(error);
  const recovery = {
    type: "search_open_candidate",
    scanIndex,
    pageNumber: currentPageNumber,
    cardIndex: pageCardIndex,
    error: {
      code: normalizeText(error?.code),
      message: normalizeText(error?.message || error)
    },
    classification,
    recovered: false,
    retried: false,
    skipped: false,
    reason: ""
  };
  if (!recoverEnabled) {
    recovery.reason = "recover_mode_disabled";
    return recovery;
  }
  if (!classification.recoverable) {
    recovery.reason = "failure_not_recoverable";
    return recovery;
  }
  if (consecutiveOpenRecoveries >= MAX_CONSECUTIVE_SEARCH_OPEN_RECOVERIES) {
    recovery.reason = "consecutive_recovery_limit_reached";
    return recovery;
  }
  if (recoveryCount >= MAX_TOTAL_SEARCH_OPEN_RECOVERIES) {
    recovery.reason = "total_recovery_limit_reached";
    return recovery;
  }

  try {
    recovery.cleanup = await closeSearchModalToList(client);
    await waitForSearchCards(client);
  } catch (cleanupError) {
    recovery.cleanupError = {
      code: normalizeText(cleanupError?.code),
      message: normalizeText(cleanupError?.message || cleanupError)
    };
    recovery.reason = "cleanup_before_retry_failed";
    return recovery;
  }
  try {
    recovery.retried = true;
    recovery.openAction = await openSearchCardByIndex(client, pageCardIndex);
    recovery.recovered = true;
    recovery.reason = "open_retry_succeeded";
    return recovery;
  } catch (retryError) {
    const retryClassification = classifyLongRunFailure(retryError);
    recovery.retryError = {
      code: normalizeText(retryError?.code),
      message: normalizeText(retryError?.message || retryError),
      classification: retryClassification
    };
    if (!retryClassification.recoverable) {
      recovery.reason = "retry_failure_not_recoverable";
      return recovery;
    }
    recovery.recovered = true;
    recovery.skipped = true;
    recovery.reason = "open_retry_failed_candidate_skipped";
    return recovery;
  }
}

function buildSearchChatChainResult({
  requestedCandidateLimit,
  requestedScanLimit,
  requestedProfile,
  requestedJobTitle,
  requestedHideRead,
  startIndex,
  stepDelayMs,
  maxPayloadChars,
  llmCalls,
  communicationClicks,
  alreadyContactedCandidates,
  passedCandidates,
  greetedCandidates,
  communicationQuotaExhausted = false,
  stopReason = "",
  violations,
  recoveries = [],
  items,
  jobPreparation = null,
  profileAction = null,
  hideReadFilter = null,
  stage = null,
  statusMessage = null,
  passed = null
} = {}) {
  return {
    schemaVersion: SEARCH_CHAT_CHAIN_SCHEMA_VERSION,
    requestedCandidateLimit,
    scanLimit: requestedScanLimit,
    scannedCandidates: items.length,
    passedCandidates,
    greetedCandidates,
    llmCalls,
    communicationClicks,
    alreadyContactedCandidates,
    actionClicks: communicationClicks,
    communicationQuotaExhausted: Boolean(communicationQuotaExhausted),
    stopReason,
    profile: requestedProfile,
    jobTitle: requestedJobTitle,
    hideRead: Boolean(requestedHideRead),
    startIndex,
    stepDelayMs,
    maxPayloadChars,
    stage,
    statusMessage,
    jobPreparation,
    profileAction,
    hideReadFilter,
    violations: [...violations],
    recoveries: [...recoveries],
    items: [...items],
    passed
  };
}

function buildSearchChatChainProgressSnapshot(state = {}) {
  const targetCandidates = Math.max(1, state.targetCandidates || 1);
  const greetedCandidates = state.greetedCandidates || 0;
  return {
    workflow: RUN_WORKFLOWS.SEARCH_CHAT_CHAIN,
    targetCandidates,
    scanLimit: state.scanLimit === null ? null : Math.max(targetCandidates, state.scanLimit || targetCandidates),
    currentScan: Number.isInteger(state.currentScan) && state.currentScan > 0 ? state.currentScan : null,
    currentTarget: Math.min(greetedCandidates + 1, targetCandidates),
    currentPageNumber: state.currentPageNumber || null,
    currentCardIndex: Number.isInteger(state.currentCardIndex) ? state.currentCardIndex : null,
    profile: state.profile || "",
    jobTitle: state.jobTitle || "",
    hideRead: Boolean(state.hideRead),
    scannedCandidates: state.scannedCandidates || 0,
    passedCandidates: state.passedCandidates || 0,
    greetedCandidates,
    llmCalls: state.llmCalls || 0,
    communicationClicks: state.communicationClicks || 0,
    alreadyContactedCandidates: state.alreadyContactedCandidates || 0,
    actionClicks: state.communicationClicks || 0,
    communicationQuotaExhausted: Boolean(state.communicationQuotaExhausted),
    stopReason: state.stopReason || "",
    currentCandidateLabel: state.currentCandidateLabel || "",
    lastItem: state.lastItem || null
  };
}

function summarizeSearchSnapshot(snapshot) {
  return {
    sourceKind: snapshot.sourceKind,
    captureSource: snapshot.captureSource,
    searchProfile: snapshot.searchProfile,
    candidateLabel: snapshot.candidateLabel,
    textHash: snapshot.textHash,
    textLength: snapshot.textLength,
    structureSignature: snapshot.structureSignature,
    sectionTitles: snapshot.sectionTitles,
    hasOpenImButton: snapshot.hasOpenImButton
  };
}

function summarizeSearchChatChainProgressItem(item = {}) {
  return {
    index: Number.isInteger(item.index) ? item.index : null,
    scanIndex: Number.isInteger(item.scanIndex) ? item.scanIndex : null,
    pageNumber: item.pageNumber || null,
    cardIndex: Number.isInteger(item.cardIndex) ? item.cardIndex : null,
    candidateLabel: buildCandidateProgressLabel(item.candidate),
    status: item.status || "",
    actionStatus: item.chatAction?.status || ""
  };
}

function buildCandidateProgressLabel(candidate = {}, snapshot = {}) {
  return normalizeText(candidate.name || candidate.label || snapshot.candidateLabel || candidate.resumeId || "");
}

function buildSearchOperatorFilter({
  operatorFilter = null,
  profile = null,
  jobTitle = null
} = {}) {
  return [
    normalizeText(operatorFilter),
    profile ? `search_profile=${normalizeText(profile)}` : "",
    jobTitle ? `job=${normalizeText(jobTitle)}` : ""
  ].filter(Boolean).join("; ");
}

function normalizeSearchCheckpoint(checkpoint, {
  profile,
  jobTitle,
  hideRead = false
} = {}) {
  if (!checkpoint || typeof checkpoint !== "object") return null;
  if (checkpoint.schemaVersion !== SEARCH_CHAT_CHAIN_CHECKPOINT_SCHEMA_VERSION) return null;
  const checkpointProfile = normalizeText(checkpoint.profile);
  const checkpointJobTitle = normalizeText(checkpoint.jobTitle);
  if (checkpointProfile && checkpointProfile !== normalizeText(profile)) {
    throw new Error(`搜索 checkpoint profile 不匹配：${checkpointProfile} != ${normalizeText(profile)}`);
  }
  if (checkpointJobTitle && checkpointJobTitle !== normalizeText(jobTitle)) {
    throw new Error(`搜索 checkpoint job 不匹配：${checkpointJobTitle} != ${normalizeText(jobTitle)}`);
  }
  if (typeof checkpoint.hideRead === "boolean" && checkpoint.hideRead !== Boolean(hideRead)) {
    throw new Error(`搜索 checkpoint hide_read 不匹配：${checkpoint.hideRead} != ${Boolean(hideRead)}`);
  }
  return {
    ...checkpoint,
    currentPageNumber: Math.max(1, Number.parseInt(String(checkpoint.currentPageNumber || 1), 10) || 1),
    pageCardIndex: Math.max(0, Number.parseInt(String(checkpoint.pageCardIndex || 0), 10) || 0),
    items: Array.isArray(checkpoint.items) ? checkpoint.items : [],
    recoveries: Array.isArray(checkpoint.recoveries) ? checkpoint.recoveries : [],
    violations: Array.isArray(checkpoint.violations) ? checkpoint.violations : [],
    communicationQuotaExhausted: Boolean(checkpoint.communicationQuotaExhausted),
    stopReason: normalizeText(checkpoint.stopReason) || "",
    seenTextHashes: Array.isArray(checkpoint.seenTextHashes) ? checkpoint.seenTextHashes : []
  };
}

function buildSearchCheckpoint({
  requestedCandidateLimit,
  requestedScanLimit,
  requestedProfile,
  requestedJobTitle,
  requestedHideRead,
  startIndex,
  stepDelayMs,
  maxPayloadChars,
  currentPageNumber,
  pageCardIndex,
  llmCalls,
  communicationClicks,
  alreadyContactedCandidates,
  passedCandidates,
  greetedCandidates,
  communicationQuotaExhausted = false,
  stopReason = "",
  seenTextHashes,
  violations,
  recoveries = [],
  items
} = {}) {
  return {
    schemaVersion: SEARCH_CHAT_CHAIN_CHECKPOINT_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    profile: requestedProfile,
    jobTitle: requestedJobTitle,
    hideRead: Boolean(requestedHideRead),
    requestedCandidateLimit,
    requestedScanLimit,
    startIndex,
    stepDelayMs,
    maxPayloadChars,
    currentPageNumber: Math.max(1, currentPageNumber || 1),
    pageCardIndex: Math.max(0, pageCardIndex || 0),
    llmCalls,
    communicationClicks,
    alreadyContactedCandidates,
    passedCandidates,
    greetedCandidates,
    communicationQuotaExhausted: Boolean(communicationQuotaExhausted),
    stopReason: normalizeText(stopReason),
    seenTextHashes: [...seenTextHashes],
    violations: [...violations],
    recoveries: [...recoveries],
    items: [...items]
  };
}

async function restoreSearchCheckpointPosition(client, {
  targetPageNumber = 1,
  pageCardIndex = 0
} = {}) {
  await waitForSearchCards(client);
  let listState = await readSearchListState(client);
  let currentPage = parsePageNumber(listState.activePageText, 1);
  const targetPage = Math.max(1, targetPageNumber || 1);
  if (currentPage > targetPage) {
    throw new Error(`搜索 checkpoint 无法从第 ${currentPage} 页回退到第 ${targetPage} 页，请重新启动 run。`);
  }
  while (currentPage < targetPage) {
    const nextPage = await clickSearchNextPage(client);
    if (!nextPage.clicked) {
      throw new Error(`搜索 checkpoint 恢复失败：无法进入第 ${currentPage + 1} 页（${nextPage.reason || "unknown"}）`);
    }
    await waitForSearchCards(client);
    listState = await readSearchListState(client);
    currentPage = parsePageNumber(listState.activePageText, currentPage + 1);
  }
  if (listState.cardCount <= 0) {
    throw new Error(`搜索 checkpoint 恢复失败：第 ${currentPage} 页没有可处理卡片。`);
  }
  return {
    currentPageNumber: currentPage,
    pageCardIndex: Math.max(0, pageCardIndex || 0)
  };
}

function parsePageNumber(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function countSearchGreetingSentItems(items = []) {
  return items.filter((item) => isSearchGreetingSentItem(item)).length;
}

function isSearchGreetingSentItem(item = {}) {
  return item.status === "search_contacted"
    && item.chatAction?.ok
    && item.chatAction?.clicked
    && item.chatAction?.status === "search_contacted";
}

function isCommunicationQuotaExhaustedItem(item = {}) {
  return item.status === COMMUNICATION_QUOTA_EXHAUSTED_STATUS
    || item.chatAction?.quotaExhausted
    || item.chatAction?.status === COMMUNICATION_QUOTA_EXHAUSTED_STATUS;
}

function isSearchOpenRecoveredSkipItem(item = {}) {
  return item.status === "search_open_recovered_skip"
    && item.recovery?.recovered
    && item.recovery?.skipped;
}

async function assertNotRiskPage(client, actionLabel) {
  const currentUrl = await client.evaluate(() => location.href);
  if (isLiepinRiskPageUrl(currentUrl)) {
    throw new Error(`检测到猎聘风控/验证码页，已停止${actionLabel}：${currentUrl}`);
  }
}
