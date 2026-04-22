import { createPageClient, discoverLiepinPages, isLiepinRiskPageUrl } from "../chrome.js";
import {
  DEFAULT_DEBUG_PORT,
  DEFAULT_RECOMMEND_STEP_DELAY_MS,
  LIEPIN_URLS,
  RUN_WORKFLOWS
} from "../constants.js";
import { runStructuredScreening, SCREENING_MODES } from "../llm-adapter.js";
import { normalizeText, sha1, sleep } from "../utils.js";
import { CHAT_ACTIONS, executeChatAction } from "./chat-action.js";
import { buildChatScreenInput } from "./chat-screen-input.js";
import { classifyChatScreeningEligibility } from "./chat-state-policy.js";
import { auditCvPayloadCoverage, buildCvScreeningInput } from "./cv-payload.js";
import {
  clickRecommendChatButton,
  extractRecommendCandidateIdentity,
  readRecommendChatButtonState,
  readRecommendEmbeddedChatSnapshot,
  waitForRecommendChatEntryVerification
} from "./recommend-action.js";
import { readRecommendModalSnapshot } from "./recommend-sampler.js";
import {
  clearRecommendBlockingOverlaysToList,
  closeRecommendModalToList
} from "./recommend-return.js";
import { chatSelectors, recommendSelectors } from "./selectors.js";

export const RECOMMEND_CHAT_CHAIN_SCHEMA_VERSION = "liepin_recommend_chat_chain_v1";

export async function runRecommendChatChain({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  candidateLimit = 5,
  scanLimit = null,
  tabLabel = "推荐",
  startIndex = 0,
  stepDelayMs = DEFAULT_RECOMMEND_STEP_DELAY_MS,
  chatEntryTimeoutMs = 30000,
  maxPayloadChars = null,
  config = null,
  recommendProvider = null,
  chatProvider = null,
  executeRequestResume = false,
  returnToRecommend = true,
  onProgress = null
} = {}) {
  const requestedCandidateLimit = Math.max(1, candidateLimit);
  const requestedScanLimit = Math.max(requestedCandidateLimit, scanLimit || requestedCandidateLimit);
  const progressState = {
    targetCandidates: requestedCandidateLimit,
    scanLimit: requestedScanLimit,
    currentScan: null,
    scannedCandidates: 0,
    chainedCandidates: 0,
    samePageChatEntries: 0,
    chatPageEntries: 0,
    screenableChatEntries: 0,
    skippedChatEntries: 0,
    recommendLlmCalls: 0,
    chatLlmCalls: 0,
    recommendChatClicks: 0,
    requestResumeClicks: 0,
    currentCandidateLabel: "",
    currentRowKey: "",
    currentEntryKind: "",
    lastItem: null
  };
  const emitProgress = (stage, statusMessage, patch = {}) => {
    Object.assign(progressState, patch);
    if (typeof onProgress !== "function") return;
    onProgress({
      stage,
      statusMessage,
      progress: buildRecommendChatChainProgressSnapshot(progressState)
    });
  };
  const pages = await discoverLiepinPages({ port });
  if (!pages.recommend && pages.riskPage) {
    throw new Error(`检测到猎聘风控/验证码页，已停止推荐到聊天串联：${pages.riskPage.url}`);
  }
  if (!pages.recommend) {
    throw new Error("未找到猎聘推荐页，请先在 Chrome 9222 打开 https://lpt.liepin.com/recommend");
  }

  const client = await createPageClient(pages.recommend);
  try {
    await assertNotRiskPage(client, "推荐到聊天串联");
    await ensureRecommendListReady(client);
    emitProgress("prepare_recommend_page", "已连接推荐页，开始推荐到聊天串联");

    const items = [];
    const seenTextHashes = new Set();
    const violations = [];
    let recommendLlmCalls = 0;
    let chatLlmCalls = 0;
    let recommendChatClicks = 0;
    let requestResumeClicks = 0;
    let samePageChatEntries = 0;
    let chatPageEntries = 0;
    let screenableChatEntries = 0;
    let skippedChatEntries = 0;
    let chainedCandidates = 0;
    const finalizeItemProgress = (item) => {
      const candidateLabel = buildCandidateProgressLabel(item.candidate);
      emitProgress(
        "candidate_completed",
        `候选人已完成：${candidateLabel || `扫描 ${item.scanIndex + 1}`} -> ${item.status}`,
        {
          scannedCandidates: items.length,
          chainedCandidates,
          samePageChatEntries,
          chatPageEntries,
          screenableChatEntries,
          skippedChatEntries,
          recommendLlmCalls,
          chatLlmCalls,
          recommendChatClicks,
          requestResumeClicks,
          currentCandidateLabel: candidateLabel,
          currentRowKey: item.chatState?.rowKey || "",
          currentEntryKind: item.chatVerification?.entryKind || "",
          lastItem: summarizeRecommendChatChainProgressItem(item)
        }
      );
    };

    for (let scanIndex = 0; scanIndex < requestedScanLimit && chainedCandidates < requestedCandidateLimit; scanIndex += 1) {
      emitProgress(
        "open_recommend_candidate",
        `正在处理第 ${scanIndex + 1}/${requestedScanLimit} 次扫描，目标串联 ${requestedCandidateLimit} 个候选人`,
        {
          currentScan: scanIndex + 1,
          currentCandidateLabel: "",
          currentRowKey: "",
          currentEntryKind: ""
        }
      );
      await prepareRecommendList(client, tabLabel);
      const openIndex = startIndex + scanIndex;
      const openAction = await openRecommendCardByIndex(client, openIndex);
      await sleep(stepDelayMs);
      await assertNotRiskPage(client, "打开推荐详情后检查");

      const snapshot = await readRecommendModalSnapshot(client, { tabLabel });
      const candidate = extractRecommendCandidateIdentity(snapshot);
      const candidateLabel = buildCandidateProgressLabel(candidate);
      emitProgress("recommend_llm", `正在评估推荐候选人：${candidateLabel || `扫描 ${scanIndex + 1}`}`, {
        currentCandidateLabel: candidateLabel
      });
      const item = {
        index: items.length,
        scanIndex,
        openIndex,
        tabLabel,
        openAction,
        candidate,
        recommendSnapshot: summarizeRecommendSnapshot(snapshot),
        recommendLlmCalled: false,
        recommendDecision: null,
        recommendChatAction: null,
        chatVerification: null,
        chatState: null,
        chatEligibility: null,
        chatLlmCalled: false,
        chatDecision: null,
        chatInputManifest: null,
        chatAction: null,
        status: "pending",
        violations: []
      };

      if (seenTextHashes.has(snapshot.textHash)) {
        item.status = "duplicate_recommend_candidate";
        item.violations.push({ code: "duplicate_recommend_candidate", textHash: snapshot.textHash });
        violations.push({ code: "duplicate_recommend_candidate", scanIndex, textHash: snapshot.textHash });
        items.push(item);
        finalizeItemProgress(item);
        await closeRecommendModalVerified(client);
        continue;
      }
      seenTextHashes.add(snapshot.textHash);

      const recommendScreenInput = buildCvScreeningInput(snapshot, { maxPayloadChars });
      const coverage = auditCvPayloadCoverage(snapshot, { maxPayloadChars });
      item.recommendInputManifest = recommendScreenInput.manifest;
      item.recommendCoverage = coverage;
      if (!coverage.passed) {
        const violation = {
          code: "recommend_coverage_audit_failed",
          scanIndex,
          textHash: snapshot.textHash,
          coverage
        };
        item.violations.push(violation);
        violations.push(violation);
      }

      const recommendScreening = await runStructuredScreening({
        mode: SCREENING_MODES.RECOMMEND,
        screenInput: recommendScreenInput,
        config,
        provider: recommendProvider
      });
      recommendLlmCalls += 1;
      item.recommendLlmCalled = true;
      item.recommendDecision = recommendScreening.decision;
      item.recommendLlmRequest = recommendScreening.request;

      if (!shouldEnterChat(item.recommendDecision)) {
        item.status = "recommend_rejected";
        item.chatAction = {
          action: "none",
          executed: false,
          clicked: false,
          status: "recommend_decision_no_chat"
        };
        items.push(item);
        finalizeItemProgress(item);
        await closeRecommendModalVerified(client);
        continue;
      }

      item.chatButtonState = await readRecommendChatButtonState(client);
      item.recommendChatAction = await clickRecommendChatButton(client);
      if (item.recommendChatAction.clicked) recommendChatClicks += 1;
      if (!item.recommendChatAction.clicked) {
        const violation = {
          code: "recommend_chat_button_not_clicked",
          scanIndex,
          reason: item.recommendChatAction.reason || "unknown"
        };
        item.status = "recommend_chat_action_failed";
        item.violations.push(violation);
        violations.push(violation);
        items.push(item);
        finalizeItemProgress(item);
        await closeRecommendModalVerified(client);
        continue;
      }
      emitProgress("wait_chat_entry", `已点击沟通，等待聊天入口：${candidateLabel || `扫描 ${scanIndex + 1}`}`, {
        recommendLlmCalls,
        recommendChatClicks
      });

      const chatVerification = await waitForRecommendChatEntryVerification({
        port,
        candidate,
        sourceTargetId: pages.recommend.id,
        timeoutMs: chatEntryTimeoutMs
      });
      item.chatVerification = summarizeChatVerification(chatVerification);
      if (!chatVerification.verified) {
        const violation = {
          code: "chat_entry_not_verified",
          scanIndex,
          chatVerification: item.chatVerification
        };
        item.status = "chat_entry_failed";
        item.violations.push(violation);
        violations.push(violation);
        items.push(item);
        finalizeItemProgress(item);
        if (returnToRecommend) await returnRecommendClientToList(client);
        continue;
      }
      if (!isSupportedChatEntryKind(chatVerification.entryKind)) {
        const violation = {
          code: "chat_entry_not_supported",
          scanIndex,
          entryKind: chatVerification.entryKind || ""
        };
        item.status = "chat_entry_unsupported_kind";
        item.violations.push(violation);
        violations.push(violation);
        items.push(item);
        finalizeItemProgress(item);
        if (returnToRecommend) await returnRecommendClientToList(client);
        continue;
      }

      chainedCandidates += 1;
      if (chatVerification.entryKind === "recommend_basic_chat_modal") {
        samePageChatEntries += 1;
      }
      if (chatVerification.entryKind === "chat_page") {
        chatPageEntries += 1;
      }
      const chatState = chatVerification.entryKind === "chat_page"
        ? buildChatPageRowState({ candidate, chatEntry: chatVerification })
        : buildRecommendBasicChatRowState({ candidate, chatEntry: chatVerification });
      const eligibility = classifyChatScreeningEligibility(chatState);
      item.chatState = chatState;
      item.chatEligibility = eligibility;

      if (!eligibility.shouldCallLlm) {
        skippedChatEntries += 1;
        item.status = "chat_skipped";
        item.chatAction = {
          action: "none",
          executed: false,
          clicked: false,
          status: eligibility.skipReason
        };
        items.push(item);
        finalizeItemProgress(item);
        if (returnToRecommend) await returnRecommendClientToList(client);
        continue;
      }

      screenableChatEntries += 1;
      emitProgress("chat_llm", `正在评估聊天状态：${candidateLabel || `扫描 ${scanIndex + 1}`}`, {
        chainedCandidates,
        samePageChatEntries,
        chatPageEntries,
        screenableChatEntries,
        recommendLlmCalls,
        recommendChatClicks,
        currentCandidateLabel: candidateLabel,
        currentRowKey: chatState.rowKey || "",
        currentEntryKind: chatVerification.entryKind || ""
      });
      const chatScreenInput = chatVerification.entryKind === "chat_page"
        ? buildChatPageScreenInput({
          candidate,
          chatEntry: chatVerification,
          chatState
        })
        : buildRecommendBasicChatScreenInput({
          candidate,
          chatEntry: chatVerification,
          chatState
        });
      item.chatInputManifest = chatScreenInput.manifest;
      if (chatScreenInput.manifest.missingRequiredSourceIds.length > 0) {
        const violation = {
          code: "chat_input_missing_required_sources",
          scanIndex,
          missingRequiredSourceIds: chatScreenInput.manifest.missingRequiredSourceIds
        };
        item.violations.push(violation);
        violations.push(violation);
      }

      const chatScreening = await runStructuredScreening({
        mode: SCREENING_MODES.CHAT,
        screenInput: chatScreenInput,
        config,
        provider: chatProvider
      });
      chatLlmCalls += 1;
      item.chatLlmCalled = true;
      item.chatDecision = chatScreening.decision;
      item.chatLlmRequest = chatScreening.request;
      item.wouldPostAction = chatScreening.decision.post_action;

      const shouldRequestResume = shouldExecuteRequestResume(chatScreening.decision);
      if (shouldRequestResume && executeRequestResume) {
        emitProgress("request_resume", `正在执行索要简历：${candidateLabel || `扫描 ${scanIndex + 1}`}`, {
          chatLlmCalls,
          currentCandidateLabel: candidateLabel,
          currentRowKey: chatState.rowKey || "",
          currentEntryKind: chatVerification.entryKind || ""
        });
        item.chatAction = chatVerification.entryKind === "chat_page"
          ? await executeChatAction({
            port,
            pageTarget: chatVerification.target
          }, {
            action: CHAT_ACTIONS.REQUEST_RESUME,
            rowKey: chatState.rowKey,
            rowLimit: 40,
            conversationFilterLabel: null
          })
          : await executeRecommendBasicChatRequestResume(client, {
            candidate,
            beforeState: chatState
          });
        if (item.chatAction.clicked) requestResumeClicks += 1;
        if (!item.chatAction.ok) {
          const violation = {
            code: "request_resume_action_failed",
            scanIndex,
            status: item.chatAction.status || ""
          };
          item.violations.push(violation);
          violations.push(violation);
        }
      } else {
        item.chatAction = {
          action: shouldRequestResume ? CHAT_ACTIONS.REQUEST_RESUME : CHAT_ACTIONS.NONE,
          executed: false,
          clicked: false,
          dryRun: shouldRequestResume && !executeRequestResume,
          status: shouldRequestResume ? "request_resume_dry_run" : "chat_decision_no_action"
        };
      }
      item.status = shouldRequestResume ? "chat_screened_request_resume" : "chat_screened_no_action";
      items.push(item);
      if (returnToRecommend) {
        emitProgress("return_to_recommend", `正在返回推荐页：${candidateLabel || `扫描 ${scanIndex + 1}`}`, {
          chatLlmCalls,
          requestResumeClicks
        });
        const returned = await returnRecommendClientToList(client);
        item.returnToRecommendResult = returned;
      }
      finalizeItemProgress(item);
    }

    const result = {
      schemaVersion: RECOMMEND_CHAT_CHAIN_SCHEMA_VERSION,
      requestedCandidateLimit,
      scanLimit: requestedScanLimit,
      scannedCandidates: items.length,
      chainedCandidates,
      samePageChatEntries,
      chatPageEntries,
      screenableChatEntries,
      skippedChatEntries,
      recommendLlmCalls,
      chatLlmCalls,
      recommendChatClicks,
      requestResumeClicks,
      actionClicks: recommendChatClicks + requestResumeClicks,
      executeRequestResume,
      returnToRecommend,
      tabLabel,
      startIndex,
      stepDelayMs,
      chatEntryTimeoutMs,
      maxPayloadChars,
      violations,
      items
    };
    return {
      ...result,
      passed: evaluateRecommendChatChain(result).passed
    };
  } finally {
    await client.disconnect();
  }
}

export function inferRecommendBasicChatResumeState(chatEntry = {}) {
  const actionText = normalizeText(chatEntry.actionBarText || chatEntry.combinedText || "");
  if (chatEntry.hasRequestResumeButton || actionText.includes("索要简历")) return "索要简历";
  if (actionText.includes("索要中") || actionText.includes("已向对方索要")) return "索要中";
  if (actionText.includes("看简历")) return "看简历";
  if (actionText.includes("浏览简历")) return "浏览简历";
  return "UNKNOWN";
}

export function buildRecommendBasicChatRowState({ candidate = {}, chatEntry = {} } = {}) {
  const rowText = normalizeText([
    candidate.name,
    chatEntry.headerName,
    chatEntry.headerBasicInfo,
    chatEntry.headerUserInfo
  ].filter(Boolean).join(" "));
  const fallbackKey = sha1([
    candidate.name,
    candidate.resumeId,
    chatEntry.headerName,
    chatEntry.headerBasicInfo
  ].join("|")).slice(0, 16);
  return {
    rowIndex: null,
    rowKey: candidate.resumeId || candidate.name || chatEntry.headerName || fallbackKey,
    rowType: "candidate",
    rowText,
    resumeState: inferRecommendBasicChatResumeState(chatEntry),
    actionLabels: extractKnownActionLabels(chatEntry.actionBarText)
  };
}

export function buildRecommendBasicChatScreenInput({ candidate = {}, chatEntry = {}, chatState = null } = {}) {
  const state = chatState || buildRecommendBasicChatRowState({ candidate, chatEntry });
  const chatHeader = normalizeText([chatEntry.headerName, chatEntry.headerBasicInfo].filter(Boolean).join(" "));
  const resumeSummary = normalizeText(chatEntry.headerBasicInfo || chatEntry.headerUserInfo || candidate.label || "");
  return buildChatScreenInput({
    row: state,
    location: chatEntry.url || LIEPIN_URLS.recommend,
    candidateHeaderText: chatHeader,
    userInfoText: normalizeText(chatEntry.headerUserInfo),
    resumeSummaryText: resumeSummary,
    messageListText: normalizeText(chatEntry.messageListText),
    actionLabels: state.actionLabels,
    hasRequestResumeButton: state.resumeState === "索要简历",
    sources: [
      ["conversation_row", state.rowText || candidate.label || candidate.name || ""],
      ["chat_header", chatHeader],
      ["header_basic_info", normalizeText(chatEntry.headerBasicInfo)],
      ["header_user_info", normalizeText(chatEntry.headerUserInfo)],
      ["header_resume_summary", resumeSummary],
      ["message_list", normalizeText(chatEntry.messageListText)],
      ["action_bar", normalizeText(chatEntry.actionBarText)]
    ].map(([id, text]) => ({ id, text })).filter((source) => source.text)
  });
}

export function buildChatPageRowState({ candidate = {}, chatEntry = {} } = {}) {
  const base = chatEntry.activeRowState || {};
  const rowText = normalizeText(
    base.rowText
    || chatEntry.activeRowText
    || [candidate.name, chatEntry.headerBasicInfo, chatEntry.headerUserInfo].filter(Boolean).join(" ")
  );
  return {
    rowIndex: Number.isInteger(base.rowIndex) && base.rowIndex >= 0 ? base.rowIndex : null,
    rowKey: base.rowKey || candidate.resumeId || candidate.name || "",
    rowType: base.rowType || "candidate",
    rowText,
    resumeState: base.resumeState || inferRecommendBasicChatResumeState(chatEntry),
    actionLabels: Array.isArray(base.actionLabels) && base.actionLabels.length > 0
      ? base.actionLabels
      : extractKnownActionLabels(chatEntry.actionBarText)
  };
}

export function buildChatPageScreenInput({ candidate = {}, chatEntry = {}, chatState = null } = {}) {
  const state = chatState || buildChatPageRowState({ candidate, chatEntry });
  const chatHeader = normalizeText(chatEntry.headerText || [chatEntry.headerBasicInfo, chatEntry.headerUserInfo].filter(Boolean).join(" "));
  return buildChatScreenInput({
    row: state,
    location: chatEntry.url || LIEPIN_URLS.chat,
    candidateHeaderText: normalizeText(chatEntry.headerBasicInfo || chatEntry.headerText),
    userInfoText: normalizeText(chatEntry.headerUserInfo),
    resumeSummaryText: normalizeText(chatEntry.resumeSummaryText),
    messageListText: normalizeText(chatEntry.messageListText || chatEntry.containerText),
    actionLabels: state.actionLabels,
    hasRequestResumeButton: Boolean(chatEntry.hasRequestResumeButton || state.resumeState === "索要简历"),
    sources: [
      ["conversation_row", state.rowText || candidate.label || candidate.name || ""],
      ["chat_header", chatHeader],
      ["header_basic_info", normalizeText(chatEntry.headerBasicInfo)],
      ["header_user_info", normalizeText(chatEntry.headerUserInfo)],
      ["header_resume_summary", normalizeText(chatEntry.resumeSummaryText)],
      ["message_list", normalizeText(chatEntry.messageListText || chatEntry.containerText)],
      ["action_bar", normalizeText(chatEntry.actionBarText)]
    ].map(([id, text]) => ({ id, text })).filter((source) => source.text)
  });
}

export function evaluateRecommendChatChain(result = {}) {
  const items = Array.isArray(result.items) ? result.items : [];
  const failures = Array.isArray(result.violations)
    ? result.violations.map((item) => item?.code || String(item))
    : [];
  const requested = result.requestedCandidateLimit || 0;

  if (result.schemaVersion && result.schemaVersion !== RECOMMEND_CHAT_CHAIN_SCHEMA_VERSION) {
    failures.push("unsupported_schema_version");
  }
  if ((result.chainedCandidates || 0) < requested) failures.push("not_enough_chained_candidates");
  if (((result.samePageChatEntries || 0) + (result.chatPageEntries || 0)) < (result.chainedCandidates || 0)) {
    failures.push("verified_chat_entry_count_mismatch");
  }
  if ((result.requestResumeClicks || 0) > 0 && !result.executeRequestResume) {
    failures.push("request_resume_clicked_without_execute_flag");
  }

  for (const item of items) {
    if (!item.recommendLlmCalled) failures.push(`candidate_${item.index}_recommend_llm_not_called`);
    if (shouldEnterChat(item.recommendDecision)) {
      if (!item.recommendChatAction?.clicked) failures.push(`candidate_${item.index}_recommend_chat_not_clicked`);
      if (!item.chatVerification?.verified) failures.push(`candidate_${item.index}_chat_not_verified`);
      if (!isSupportedChatEntryKind(item.chatVerification?.entryKind)) {
        failures.push(`candidate_${item.index}_chat_entry_kind_not_supported`);
      }
    }
    if (item.chatEligibility?.shouldCallLlm && !item.chatLlmCalled) {
      failures.push(`candidate_${item.index}_chat_llm_not_called`);
    }
    if (item.chatEligibility && !item.chatEligibility.shouldCallLlm && item.chatLlmCalled) {
      failures.push(`candidate_${item.index}_chat_llm_called_for_skipped_state`);
    }
    if (item.chatAction?.clicked && item.chatState?.resumeState !== "索要简历") {
      failures.push(`candidate_${item.index}_request_resume_clicked_from_non_screenable_state`);
    }
    if (item.chatAction?.clicked && item.chatAction.action !== CHAT_ACTIONS.REQUEST_RESUME) {
      failures.push(`candidate_${item.index}_unexpected_chat_action_clicked`);
    }
  }

  return {
    passed: dedupeStrings(failures).length === 0,
    failures: dedupeStrings(failures)
  };
}

export function summarizeRecommendChatChain(result = {}) {
  const evaluation = evaluateRecommendChatChain(result);
  return {
    ok: Boolean(result.passed),
    requestedCandidateLimit: result.requestedCandidateLimit || 0,
    scannedCandidates: result.scannedCandidates || 0,
    chainedCandidates: result.chainedCandidates || 0,
    samePageChatEntries: result.samePageChatEntries || 0,
    chatPageEntries: result.chatPageEntries || 0,
    screenableChatEntries: result.screenableChatEntries || 0,
    skippedChatEntries: result.skippedChatEntries || 0,
    recommendLlmCalls: result.recommendLlmCalls || 0,
    chatLlmCalls: result.chatLlmCalls || 0,
    recommendChatClicks: result.recommendChatClicks || 0,
    requestResumeClicks: result.requestResumeClicks || 0,
    actionClicks: result.actionClicks || 0,
    executeRequestResume: Boolean(result.executeRequestResume),
    violations: evaluation.failures
  };
}

function buildRecommendChatChainProgressSnapshot(state = {}) {
  const targetCandidates = Math.max(1, state.targetCandidates || 1);
  const chainedCandidates = state.chainedCandidates || 0;
  const recommendChatClicks = state.recommendChatClicks || 0;
  const requestResumeClicks = state.requestResumeClicks || 0;
  return {
    workflow: RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
    targetCandidates,
    scanLimit: Math.max(targetCandidates, state.scanLimit || targetCandidates),
    currentScan: Number.isInteger(state.currentScan) && state.currentScan > 0 ? state.currentScan : null,
    currentTarget: Math.min(chainedCandidates + 1, targetCandidates),
    scannedCandidates: state.scannedCandidates || 0,
    chainedCandidates,
    samePageChatEntries: state.samePageChatEntries || 0,
    chatPageEntries: state.chatPageEntries || 0,
    screenableChatEntries: state.screenableChatEntries || 0,
    skippedChatEntries: state.skippedChatEntries || 0,
    recommendLlmCalls: state.recommendLlmCalls || 0,
    chatLlmCalls: state.chatLlmCalls || 0,
    recommendChatClicks,
    requestResumeClicks,
    actionClicks: recommendChatClicks + requestResumeClicks,
    currentCandidateLabel: state.currentCandidateLabel || "",
    currentRowKey: state.currentRowKey || "",
    currentEntryKind: state.currentEntryKind || "",
    lastItem: state.lastItem || null
  };
}

function shouldEnterChat(decision = {}) {
  return decision.decision === "pass" && decision.post_action === "chat";
}

function shouldExecuteRequestResume(decision = {}) {
  return decision.decision === "pass" && decision.post_action === CHAT_ACTIONS.REQUEST_RESUME;
}

function isSupportedChatEntryKind(entryKind) {
  return entryKind === "recommend_basic_chat_modal" || entryKind === "chat_page";
}

async function prepareRecommendList(client, tabLabel) {
  await ensureRecommendListReady(client);
  await switchRecommendTab(client, tabLabel);
  await resetRecommendListToTop(client);
  await waitForRecommendCards(client);
}

async function switchRecommendTab(client, tabLabel) {
  if (!tabLabel) return { clicked: false, active: false, reason: "empty_tab_label" };
  const result = await client.evaluate((selectors, label) => {
    const getText = (node) => (node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
    const labels = [...document.querySelectorAll(selectors.segmentedLabel)];
    const match = labels.find((node) => getText(node) === label);
    if (!match) return { clicked: false, active: false, reason: "tab_not_found" };
    const item = match.closest(".ant-lpt-segmented-item");
    const alreadyActive = String(item?.className || "").includes("selected");
    if (!alreadyActive) match.click();
    return {
      clicked: !alreadyActive,
      active: alreadyActive,
      label: getText(match)
    };
  }, recommendSelectors, tabLabel);
  await sleep(1400);
  return result;
}

async function waitForRecommendCards(client) {
  const ready = await client.waitFor((selector) => Boolean(document.querySelector(selector)), [recommendSelectors.card], {
    timeoutMs: 10000,
    pollMs: 250
  });
  if (!ready) throw new Error("推荐页候选人卡片未出现");
}

async function openRecommendCardByIndex(client, index) {
  const result = await client.evaluate(({ selector, cardIndex }) => {
    const cards = [...document.querySelectorAll(selector)];
    const card = cards[cardIndex];
    if (!card) return { clicked: false, reason: "card_not_found", cardCount: cards.length };
    const key = card.getAttribute("data-tlg-ext")
      || card.getAttribute("data-id")
      || card.getAttribute("data-key")
      || "";
    card.scrollIntoView({ block: "center" });
    card.click();
    return {
      clicked: true,
      cardIndex,
      cardCount: cards.length,
      key
    };
  }, {
    selector: recommendSelectors.card,
    cardIndex: index
  });
  if (!result.clicked) {
    throw new Error(`未找到可打开的推荐卡片 index=${index} cardCount=${result.cardCount}`);
  }
  const ready = await client.waitFor((selector) => {
    const node = document.querySelector(selector);
    return node && (node.textContent || node.innerText || "").trim().length > 100;
  }, [recommendSelectors.modalPrintable], {
    timeoutMs: 10000,
    pollMs: 250
  });
  if (!ready) throw new Error("推荐详情弹窗未出现");
  return result;
}

async function closeRecommendModalVerified(client) {
  return closeRecommendModalToList(client);
}

async function ensureRecommendListReady(client) {
  const cleanup = await clearRecommendBlockingOverlaysToList(client);
  if (!cleanup.closed) {
    throw new Error(`推荐页存在未关闭遮罩，且无法通过关闭弹层返回列表：${cleanup.reason || "unknown"}`);
  }
}

async function resetRecommendListToTop(client) {
  await client.evaluate(() => {
    window.scrollTo(0, 0);
    window.dispatchEvent(new Event("scroll"));
  });
  await sleep(700);
}

async function executeRecommendBasicChatRequestResume(client, { candidate, beforeState }) {
  if (beforeState.resumeState !== "索要简历") {
    return {
      action: CHAT_ACTIONS.REQUEST_RESUME,
      executed: false,
      clicked: false,
      before: beforeState,
      after: beforeState,
      ok: false,
      status: "target_not_screenable"
    };
  }

  const click = await client.evaluate((selectors) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const roots = [
      document.querySelector(".im-ui-basic-chat-modal"),
      document.querySelector(".im-ui-chat-modal-container"),
      document
    ].filter(Boolean);
    for (const root of roots) {
      const button = root.querySelector(selectors.resumeActionButton);
      if (button && getText(button) === "索要简历") {
        button.click();
        return {
          clicked: true,
          text: getText(button),
          className: String(button.className || "")
        };
      }
    }
    return { clicked: false, reason: "request_resume_button_not_found" };
  }, chatSelectors);
  if (!click.clicked) {
    return {
      action: CHAT_ACTIONS.REQUEST_RESUME,
      executed: false,
      clicked: false,
      before: beforeState,
      after: beforeState,
      ok: false,
      status: click.reason || "request_resume_button_not_found",
      click
    };
  }

  const confirmation = await confirmResumeRequestIfPresent(client);
  const after = await waitForEmbeddedResumeStateChange(client, { candidate, beforeState });
  return {
    action: CHAT_ACTIONS.REQUEST_RESUME,
    executed: true,
    clicked: true,
    click,
    confirmation,
    before: beforeState,
    after,
    ok: Boolean(after && after.resumeState !== "索要简历"),
    status: after?.resumeState !== "索要简历"
      ? "request_resume_clicked"
      : "request_resume_state_not_changed"
  };
}

async function confirmResumeRequestIfPresent(client) {
  const modal = await client.evaluate(() => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const compactText = (node) => getText(node).replace(/\s+/g, "");
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const modalRoot = [...document.querySelectorAll('.ant-im-modal, [role="dialog"]')]
      .find((node) => visible(node) && /确定向对方索要简历吗/u.test(getText(node)));
    if (!modalRoot) return { present: false, clicked: false };
    const buttons = [...modalRoot.querySelectorAll("button")]
      .filter((node) => visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true");
    const confirmButton = buttons.find((node) => compactText(node) === "确定")
      || buttons.find((node) => compactText(node).includes("确定") && String(node.className || "").includes("primary"));
    if (!confirmButton) {
      return {
        present: true,
        clicked: false,
        modalText: getText(modalRoot),
        buttonTexts: buttons.map((node) => getText(node))
      };
    }
    confirmButton.click();
    return {
      present: true,
      clicked: true,
      clickedText: getText(confirmButton),
      clickedBy: "dom_button_click"
    };
  });
  if (!modal?.clicked) return modal || { present: false, clicked: false };
  const modalClosed = await client.waitFor(() => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    return ![...document.querySelectorAll('.ant-im-modal, [role="dialog"]')]
      .some((node) => visible(node) && /确定向对方索要简历吗/u.test(getText(node)));
  }, [], {
    timeoutMs: 3000,
    pollMs: 150
  });
  await sleep(1000);
  return {
    ...modal,
    modalClosed: Boolean(modalClosed)
  };
}

async function waitForEmbeddedResumeStateChange(client, { candidate, beforeState }) {
  let latest = beforeState;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(500);
    const chatEntry = await readRecommendEmbeddedChatSnapshot(client, candidate);
    latest = buildRecommendBasicChatRowState({ candidate, chatEntry });
    if (latest.resumeState !== "索要简历") return latest;
  }
  return latest;
}

function summarizeRecommendSnapshot(snapshot) {
  return {
    sourceKind: snapshot.sourceKind,
    captureSource: snapshot.captureSource,
    candidateLabel: snapshot.candidateLabel,
    textHash: snapshot.textHash,
    textLength: snapshot.textLength,
    structureSignature: snapshot.structureSignature,
    sectionTitles: snapshot.sectionTitles,
    hasOpenImButton: snapshot.hasOpenImButton
  };
}

function summarizeChatVerification(chatVerification = {}) {
  return {
    verified: Boolean(chatVerification.verified),
    entryKind: chatVerification.entryKind || "",
    candidateNameMatched: Boolean(chatVerification.candidateNameMatched),
    hasRequestResumeButton: Boolean(chatVerification.hasRequestResumeButton),
    hasJumpToChatPage: Boolean(chatVerification.hasJumpToChatPage),
    headerName: chatVerification.headerName || "",
    headerBasicInfo: chatVerification.headerBasicInfo || "",
    headerUserInfo: chatVerification.headerUserInfo || "",
    actionBarText: chatVerification.actionBarText || "",
    messageListText: chatVerification.messageListText || "",
    reason: chatVerification.reason || "",
    url: chatVerification.url || ""
  };
}

function extractKnownActionLabels(actionBarText) {
  const text = normalizeText(actionBarText);
  const labels = [];
  for (const label of ["索要简历", "索要中", "已向对方索要", "看简历", "浏览简历", "跳转沟通页"]) {
    if (text.includes(label)) labels.push(label === "已向对方索要" ? "索要中" : label);
  }
  return dedupeStrings(labels);
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildCandidateProgressLabel(candidate = {}) {
  return normalizeText(candidate.name || candidate.label || candidate.resumeId || "");
}

function summarizeRecommendChatChainProgressItem(item = {}) {
  return {
    index: Number.isInteger(item.index) ? item.index : null,
    scanIndex: Number.isInteger(item.scanIndex) ? item.scanIndex : null,
    candidateLabel: buildCandidateProgressLabel(item.candidate),
    rowKey: item.chatState?.rowKey || item.candidate?.resumeId || "",
    status: item.status || "",
    entryKind: item.chatVerification?.entryKind || "",
    resumeState: item.chatState?.resumeState || "",
    actionStatus: item.chatAction?.status || item.recommendChatAction?.status || ""
  };
}

async function returnRecommendClientToList(client) {
  const closeAction = await closeRecommendModalVerified(client);
  return {
    ok: Boolean(closeAction?.closed),
    closeAction
  };
}

async function assertNotRiskPage(client, actionLabel) {
  const currentUrl = await client.evaluate(() => location.href);
  if (isLiepinRiskPageUrl(currentUrl)) {
    throw new Error(`检测到猎聘风控/验证码页，已停止${actionLabel}：${currentUrl}`);
  }
}
