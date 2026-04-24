import {
  createPageClient,
  discoverLiepinPages,
  isLiepinRiskPageUrl
} from "../chrome.js";
import {
  DEFAULT_DEBUG_PORT,
  DEFAULT_RECOMMEND_STEP_DELAY_MS,
  RUN_WORKFLOWS
} from "../constants.js";
import { runStructuredScreening, SCREENING_MODES } from "../llm-adapter.js";
import { normalizeText, sleep } from "../utils.js";
import { auditCvPayloadCoverage, buildCvScreeningInput } from "./cv-payload.js";
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
  readSearchPaginationState,
  waitForSearchCards
} from "./search-action.js";

export const SEARCH_CHAT_CHAIN_SCHEMA_VERSION = "liepin_search_chat_chain_v1";
export const SEARCH_CHAT_CHAIN_CHECKPOINT_SCHEMA_VERSION = "liepin_search_chat_chain_checkpoint_v1";

export async function runSearchChatChain({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  candidateLimit = 5,
  scanLimit = null,
  profile = null,
  jobTitle = null,
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
  onProgress = null
} = {}) {
  const requestedProfile = normalizeText(profile);
  const requestedJobTitle = normalizeText(jobTitle);
  if (!requestedProfile) throw new Error("search_chat_chain 需要 profile，请先调用 liepin_search_options 让用户选择。");
  if (!requestedJobTitle) throw new Error("search_chat_chain 需要 job，请先调用 liepin_search_options 让用户选择开聊职位。");

  const requestedCandidateLimit = Math.max(1, candidateLimit);
  const requestedScanLimit = scanLimit
    ? Math.max(requestedCandidateLimit, scanLimit)
    : null;
  const restoredCheckpoint = normalizeSearchCheckpoint(checkpoint, {
    profile: requestedProfile,
    jobTitle: requestedJobTitle
  });
  const items = restoredCheckpoint?.items ? [...restoredCheckpoint.items] : [];
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
  let currentPageNumber = restoredCheckpoint?.currentPageNumber || 1;
  let pageCardIndex = restoredCheckpoint?.pageCardIndex ?? Math.max(0, startIndex || 0);

  const progressState = {
    targetCandidates: requestedCandidateLimit,
    scanLimit: requestedScanLimit,
    profile: requestedProfile,
    jobTitle: requestedJobTitle,
    currentScan: null,
    currentPageNumber,
    currentCardIndex: null,
    scannedCandidates: items.length,
    passedCandidates,
    llmCalls,
    communicationClicks,
    alreadyContactedCandidates,
    currentCandidateLabel: "",
    lastItem: null
  };
  const buildPartialWorkflowResult = (stage, statusMessage) => {
    const result = buildSearchChatChainResult({
      requestedCandidateLimit,
      requestedScanLimit,
      requestedProfile,
      requestedJobTitle,
      startIndex,
      stepDelayMs,
      maxPayloadChars,
      llmCalls,
      communicationClicks,
      alreadyContactedCandidates,
      passedCandidates,
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
      emitProgress("prepare_search_page", `已连接搜索页，准备 profile=${requestedProfile} job=${requestedJobTitle}`);
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

      while ((requestedScanLimit === null || items.length < requestedScanLimit) && passedCandidates < requestedCandidateLimit) {
        await assertNotRiskPage(client, "搜索串联扫描中");
        await waitForSearchCards(client);
        const listState = await readSearchListState(client);
        currentPageNumber = parsePageNumber(listState.activePageText, currentPageNumber);
        if (pageCardIndex >= listState.cardCount) {
          const pagination = await readSearchPaginationState(client);
          if (!pagination.nextExists || pagination.nextDisabled) {
            violations.push({
              code: "search_reached_last_page_before_target",
              scannedCandidates: items.length,
              passedCandidates,
              requestedCandidateLimit
            });
            break;
          }
          const nextPage = await clickSearchNextPage(client);
          if (!nextPage.clicked) {
            violations.push({
              code: "search_next_page_not_clicked",
              reason: nextPage.reason || "unknown"
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
        const openAction = await openSearchCardByIndex(client, pageCardIndex);
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
          if (item.chatAction.clicked) communicationClicks += 1;
          if (item.chatAction.status === "already_contacted") alreadyContactedCandidates += 1;
          if (item.chatAction.ok) {
            passedCandidates += 1;
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
          const closeAction = await closeSearchModalToList(client);
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
            const checkpointPayload = buildSearchCheckpoint({
              requestedCandidateLimit,
              requestedScanLimit,
              requestedProfile,
              requestedJobTitle,
              startIndex,
              stepDelayMs,
              maxPayloadChars,
              currentPageNumber,
              pageCardIndex,
              llmCalls,
              communicationClicks,
              alreadyContactedCandidates,
              passedCandidates,
              seenTextHashes,
              violations,
              items
            });
            const partialResult = buildPartialWorkflowResult("search_checkpoint", "已保存搜索 checkpoint");
            if (typeof onCheckpoint === "function") {
              await onCheckpoint(checkpointPayload, partialResult);
            }
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
        startIndex,
        stepDelayMs,
        maxPayloadChars,
        llmCalls,
        communicationClicks,
        alreadyContactedCandidates,
        passedCandidates,
        violations,
        items,
        jobPreparation,
        profileAction
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
      llmCalls,
      communicationClicks,
      alreadyContactedCandidates,
      currentCandidateLabel: buildCandidateProgressLabel(item.candidate),
      lastItem: summarizeSearchChatChainProgressItem(item)
    });
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
  if ((result.passedCandidates || 0) < (result.requestedCandidateLimit || 0)) {
    failures.push("not_enough_passed_candidates");
  }
  for (const item of items) {
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
    requestedCandidateLimit: result.requestedCandidateLimit || 0,
    scannedCandidates: result.scannedCandidates || 0,
    passedCandidates: result.passedCandidates || 0,
    llmCalls: result.llmCalls || 0,
    communicationClicks: result.communicationClicks || 0,
    alreadyContactedCandidates: result.alreadyContactedCandidates || 0,
    actionClicks: result.actionClicks || 0,
    violations: evaluation.failures
  };
}

export function shouldExecuteSearchChat(decision = {}) {
  return decision?.decision === "pass" && decision?.post_action === "chat";
}

function buildSearchChatChainResult({
  requestedCandidateLimit,
  requestedScanLimit,
  requestedProfile,
  requestedJobTitle,
  startIndex,
  stepDelayMs,
  maxPayloadChars,
  llmCalls,
  communicationClicks,
  alreadyContactedCandidates,
  passedCandidates,
  violations,
  items,
  jobPreparation = null,
  profileAction = null,
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
    llmCalls,
    communicationClicks,
    alreadyContactedCandidates,
    actionClicks: communicationClicks,
    profile: requestedProfile,
    jobTitle: requestedJobTitle,
    startIndex,
    stepDelayMs,
    maxPayloadChars,
    stage,
    statusMessage,
    jobPreparation,
    profileAction,
    violations: [...violations],
    items: [...items],
    passed
  };
}

function buildSearchChatChainProgressSnapshot(state = {}) {
  const targetCandidates = Math.max(1, state.targetCandidates || 1);
  return {
    workflow: RUN_WORKFLOWS.SEARCH_CHAT_CHAIN,
    targetCandidates,
    scanLimit: state.scanLimit === null ? null : Math.max(targetCandidates, state.scanLimit || targetCandidates),
    currentScan: Number.isInteger(state.currentScan) && state.currentScan > 0 ? state.currentScan : null,
    currentTarget: Math.min((state.passedCandidates || 0) + 1, targetCandidates),
    currentPageNumber: state.currentPageNumber || null,
    currentCardIndex: Number.isInteger(state.currentCardIndex) ? state.currentCardIndex : null,
    profile: state.profile || "",
    jobTitle: state.jobTitle || "",
    scannedCandidates: state.scannedCandidates || 0,
    passedCandidates: state.passedCandidates || 0,
    llmCalls: state.llmCalls || 0,
    communicationClicks: state.communicationClicks || 0,
    alreadyContactedCandidates: state.alreadyContactedCandidates || 0,
    actionClicks: state.communicationClicks || 0,
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
  jobTitle
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
  return {
    ...checkpoint,
    currentPageNumber: Math.max(1, Number.parseInt(String(checkpoint.currentPageNumber || 1), 10) || 1),
    pageCardIndex: Math.max(0, Number.parseInt(String(checkpoint.pageCardIndex || 0), 10) || 0),
    items: Array.isArray(checkpoint.items) ? checkpoint.items : [],
    violations: Array.isArray(checkpoint.violations) ? checkpoint.violations : [],
    seenTextHashes: Array.isArray(checkpoint.seenTextHashes) ? checkpoint.seenTextHashes : []
  };
}

function buildSearchCheckpoint({
  requestedCandidateLimit,
  requestedScanLimit,
  requestedProfile,
  requestedJobTitle,
  startIndex,
  stepDelayMs,
  maxPayloadChars,
  currentPageNumber,
  pageCardIndex,
  llmCalls,
  communicationClicks,
  alreadyContactedCandidates,
  passedCandidates,
  seenTextHashes,
  violations,
  items
} = {}) {
  return {
    schemaVersion: SEARCH_CHAT_CHAIN_CHECKPOINT_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    profile: requestedProfile,
    jobTitle: requestedJobTitle,
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
    seenTextHashes: [...seenTextHashes],
    violations: [...violations],
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

async function assertNotRiskPage(client, actionLabel) {
  const currentUrl = await client.evaluate(() => location.href);
  if (isLiepinRiskPageUrl(currentUrl)) {
    throw new Error(`检测到猎聘风控/验证码页，已停止${actionLabel}：${currentUrl}`);
  }
}
