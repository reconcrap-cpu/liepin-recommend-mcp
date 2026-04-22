import { createPageClient, discoverLiepinPages } from "../chrome.js";
import { DEFAULT_DEBUG_PORT } from "../constants.js";
import { runStructuredScreening, SCREENING_MODES } from "../llm-adapter.js";
import { normalizeText, sleep } from "../utils.js";
import { activateAndReadChatRow, setChatSegmentFilter } from "./chat-sampler.js";
import { readActiveChatScreenInput } from "./chat-screen-input.js";
import { classifyChatScreeningEligibility } from "./chat-state-policy.js";
import { assertPageRuntimeResponsive } from "./page-health.js";
import { chatSelectors } from "./selectors.js";

export const CHAT_DRY_RUN_SCHEMA_VERSION = "liepin_chat_dry_run_v1";

export async function runChatDryRunScreening({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  candidateLimit = 20,
  rowLimit = 40,
  conversationFilterLabel = "有简历",
  maxScrollPasses = 3,
  config = null,
  provider = null
} = {}) {
  const pages = await discoverLiepinPages({ port });
  if (!pages.chat) {
    throw new Error("未找到猎聘聊天页，请先在 Chrome 9222 打开 https://lpt.liepin.com/chat/im");
  }
  const client = await createPageClient(pages.chat);
  try {
    await assertPageRuntimeResponsive(client, { pageName: "猎聘聊天页" });
    if (conversationFilterLabel) {
      await setChatSegmentFilter(client, conversationFilterLabel);
    }
    const ready = await client.waitFor((selector) => Boolean(document.querySelector(selector)), [chatSelectors.conversationRow], {
      timeoutMs: 10000,
      pollMs: 250
    });
    if (!ready) throw new Error("聊天列表未出现");

    const items = [];
    const seenRows = new Set();
    const violations = [];
    let observedRows = 0;
    let processedCandidates = 0;
    let llmCalls = 0;

    for (let pass = 0; pass < maxScrollPasses && processedCandidates < candidateLimit; pass += 1) {
      const rowCount = await client.evaluate((selector) => document.querySelectorAll(selector).length, chatSelectors.conversationRow);
      const cappedRowCount = Math.min(rowCount, rowLimit);
      let newRowsThisPass = 0;

      for (let index = 0; index < cappedRowCount && processedCandidates < candidateLimit; index += 1) {
        const state = await activateAndReadChatRow(client, index);
        if (!state) break;
        if (seenRows.has(state.rowKey)) continue;
        seenRows.add(state.rowKey);
        observedRows += 1;
        newRowsThisPass += 1;

        if (state.rowType !== "candidate") {
          items.push(buildSkippedItem(state, {
            reason: "non_candidate_row",
            llmCalled: false
          }));
          continue;
        }

        processedCandidates += 1;
        const eligibility = classifyChatScreeningEligibility(state);
        if (!eligibility.shouldCallLlm) {
          items.push(buildSkippedItem(state, {
            reason: eligibility.reason,
            eligibility,
            llmCalled: false
          }));
          continue;
        }

        const beforeState = state;
        const screenInput = await readActiveChatScreenInput(client, state);
        const screening = await runStructuredScreening({
          mode: SCREENING_MODES.CHAT,
          screenInput,
          config,
          provider
        });
        llmCalls += 1;
        const afterState = await activateAndReadChatRow(client, beforeState.rowIndex);
        const drift = detectDryRunActionDrift(beforeState, afterState);
        if (drift) violations.push(drift);
        items.push({
          index: beforeState.rowIndex,
          rowKey: beforeState.rowKey,
          rowIndex: beforeState.rowIndex,
          rowType: beforeState.rowType,
          resumeState: beforeState.resumeState,
          status: "screened",
          llmCalled: true,
          llmRequest: screening.request,
          chatInputManifest: screenInput.manifest,
          decision: screening.decision,
          wouldPostAction: screening.decision.post_action,
          actionExecuted: false,
          beforeState,
          afterState,
          manifest: screenInput.manifest,
          missingRequiredSourceIds: screenInput.manifest?.missingRequiredSourceIds || [],
          reasoningCaptured: screening.reasoningCaptured
        });
      }

      if (processedCandidates >= candidateLimit) break;
      const scrolled = await scrollConversationList(client);
      if (!scrolled || newRowsThisPass === 0) break;
      await sleep(900);
    }

    const result = {
      schemaVersion: CHAT_DRY_RUN_SCHEMA_VERSION,
      dryRun: true,
      filterLabel: conversationFilterLabel,
      requestedCandidateLimit: candidateLimit,
      observedRows,
      processedCandidates,
      screenableCandidates: items.filter((item) => item.status === "screened").length,
      skippedRows: items.filter((item) => item.status === "skipped").length,
      llmCalls,
      actionClicks: 0,
      violations,
      items
    };
    return {
      ...result,
      passed: result.processedCandidates >= candidateLimit && result.violations.length === 0
    };
  } finally {
    await client.disconnect();
  }
}

export function buildMockChatScreeningProvider({
  decision = "fail",
  postAction = "none",
  reasoningText = ""
} = {}) {
  const normalizedDecision = normalizeText(decision) || "fail";
  const normalizedPostAction = normalizeText(postAction) || "none";
  return async ({ onReasoningDelta }) => {
    if (reasoningText) onReasoningDelta(reasoningText);
    return {
      content: JSON.stringify({
        decision: normalizedDecision,
        post_action: normalizedPostAction
      })
    };
  };
}

export function summarizeChatDryRunScreening(result) {
  return {
    ok: Boolean(result?.passed),
    dryRun: Boolean(result?.dryRun),
    processedCandidates: result?.processedCandidates || 0,
    screenableCandidates: result?.screenableCandidates || 0,
    skippedRows: result?.skippedRows || 0,
    llmCalls: result?.llmCalls || 0,
    actionClicks: result?.actionClicks || 0,
    violations: result?.violations || []
  };
}

function buildSkippedItem(state, {
  reason,
  eligibility = null,
  llmCalled = false
}) {
  return {
    index: state.rowIndex,
    rowKey: state.rowKey,
    rowIndex: state.rowIndex,
    rowType: state.rowType,
    resumeState: state.resumeState,
    status: "skipped",
    reason,
    eligibility,
    llmCalled,
    actionExecuted: false
  };
}

function detectDryRunActionDrift(beforeState, afterState) {
  if (!afterState) {
    return {
      code: "dry_run_after_state_missing",
      rowKey: beforeState.rowKey
    };
  }
  if (afterState.rowKey !== beforeState.rowKey) {
    return {
      code: "dry_run_candidate_changed",
      beforeRowKey: beforeState.rowKey,
      afterRowKey: afterState.rowKey
    };
  }
  if (beforeState.resumeState === "索要简历" && afterState.resumeState !== "索要简历") {
    return {
      code: "dry_run_resume_state_changed",
      rowKey: beforeState.rowKey,
      beforeState: beforeState.resumeState,
      afterState: afterState.resumeState
    };
  }
  return null;
}

async function scrollConversationList(client) {
  return client.evaluate((selector) => {
    const firstRow = document.querySelector(selector);
    if (!firstRow) return false;
    const candidates = [];
    let node = firstRow.parentElement;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 20) {
        candidates.push(node);
      }
      node = node.parentElement;
    }
    const scroller = candidates[0] || firstRow.closest(".im-ui-contacts-wrap");
    if (!scroller) return false;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + Math.max(scroller.clientHeight, 300);
    return scroller.scrollTop !== before;
  }, chatSelectors.conversationRow);
}
