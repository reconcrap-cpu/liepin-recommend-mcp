import { createPageClient, discoverLiepinPages, isLiepinRiskPageUrl } from "../chrome.js";
import { DEFAULT_DEBUG_PORT, DEFAULT_RECOMMEND_STEP_DELAY_MS, RUN_WORKFLOWS } from "../constants.js";
import { runStructuredScreening, SCREENING_MODES } from "../llm-adapter.js";
import { normalizeText, sleep } from "../utils.js";
import { auditCvPayloadCoverage, buildCvScreeningInput } from "./cv-payload.js";
import { readRecommendModalSnapshot } from "./recommend-sampler.js";
import {
  clearRecommendBlockingOverlaysToList,
  closeRecommendModalToList
} from "./recommend-return.js";
import { recommendSelectors } from "./selectors.js";

export const RECOMMEND_DRY_RUN_SCHEMA_VERSION = "liepin_recommend_dry_run_v1";

export async function runRecommendDryRunScreening({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  candidateLimit = 20,
  tabLabel = "推荐",
  startIndex = 0,
  stepDelayMs = DEFAULT_RECOMMEND_STEP_DELAY_MS,
  maxPayloadChars = null,
  criteria = null,
  operatorFilter = null,
  config = null,
  provider = null,
  reasoningLogPath = null,
  onProgress = null
} = {}) {
  const pages = await discoverLiepinPages({ port });
  if (!pages.recommend && pages.riskPage) {
    throw new Error(`检测到猎聘风控/验证码页，已停止推荐 dry-run screening：${pages.riskPage.url}`);
  }
  if (!pages.recommend) {
    throw new Error("未找到猎聘推荐页，请先在 Chrome 9222 打开 https://lpt.liepin.com/recommend");
  }

  const client = await createPageClient(pages.recommend);
  try {
    const items = [];
    const seenTextHashes = new Set();
    const violations = [];
    let llmCalls = 0;
    const progressState = {
      targetCandidates: candidateLimit,
      processedCandidates: 0,
      screenableCandidates: 0,
      llmCalls: 0,
      actionClicks: 0,
      currentCandidateLabel: "",
      currentIndex: null,
      lastItem: null
    };
    const buildPartialWorkflowResult = (stage, statusMessage) => {
      const result = buildRecommendDryRunResult({
        candidateLimit,
        llmCalls,
        tabLabel,
        startIndex,
        stepDelayMs,
        maxPayloadChars,
        openAction: null,
        closeAction: null,
        violations,
        items,
        passed: false,
        stage,
        statusMessage
      });
      return {
        workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
        summary: summarizeRecommendDryRunScreening(result),
        result
      };
    };
    const emitProgress = (stage, statusMessage, patch = {}) => {
      Object.assign(progressState, patch);
      if (typeof onProgress !== "function") return;
      onProgress({
        stage,
        statusMessage,
        progress: buildRecommendDryRunProgressSnapshot(progressState),
        partialResult: buildPartialWorkflowResult(stage, statusMessage)
      });
    };

    try {
      await assertNotRiskPage(client, "推荐 dry-run screening");
      await ensureRecommendListReady(client);
      emitProgress("prepare_recommend_page", "已连接推荐页，开始 dry-run screening");
      await switchRecommendTab(client, tabLabel);
      await resetRecommendListToTop(client);
      await waitForRecommendCards(client);

      const openAction = await openRecommendCardByIndex(client, startIndex);
      await sleep(stepDelayMs);
      await assertNotRiskPage(client, "打开推荐详情后检查");

      for (let index = 0; index < candidateLimit; index += 1) {
        emitProgress("open_recommend_candidate", `正在处理候选人 ${index + 1}/${candidateLimit}`, {
          currentIndex: index + 1
        });
        const snapshot = await readRecommendModalSnapshot(client, { tabLabel });
        if (seenTextHashes.has(snapshot.textHash)) {
          violations.push({
            code: "duplicate_or_stale_modal_snapshot",
            index,
            textHash: snapshot.textHash
          });
          break;
        }
        seenTextHashes.add(snapshot.textHash);

        const screenInput = buildCvScreeningInput(snapshot, { maxPayloadChars });
        const coverage = auditCvPayloadCoverage(snapshot, { maxPayloadChars });
        if (!coverage.passed) {
          violations.push({
            code: "coverage_audit_failed",
            index,
            textHash: snapshot.textHash,
            coverage
          });
        }

        emitProgress("recommend_llm", `正在评估推荐候选人：${screenInput.candidate?.label || snapshot.candidateLabel || `候选人 ${index + 1}`}`, {
          currentCandidateLabel: screenInput.candidate?.label || snapshot.candidateLabel || "",
          currentIndex: index + 1
        });
        const screening = await runStructuredScreening({
          mode: SCREENING_MODES.RECOMMEND,
          screenInput,
          criteria,
          operatorFilters: operatorFilter,
          config,
          provider,
          reasoningLogPath
        });
        llmCalls += 1;

        const afterSnapshot = await readRecommendModalSnapshot(client, { tabLabel });
        const drift = detectDryRunModalDrift(snapshot, afterSnapshot, index);
        if (drift) violations.push(drift);

        const item = {
          index,
          status: "screened",
          tabLabel,
          candidateLabel: screenInput.candidate?.label || snapshot.candidateLabel || "",
          textHash: snapshot.textHash,
          structureSignature: snapshot.structureSignature,
          sectionTitles: snapshot.sectionTitles,
          parsedPresentSectionIds: screenInput.manifest.parsedPresentSectionIds,
          manifest: screenInput.manifest,
          coverage,
          llmCalled: true,
          llmRequest: screening.request,
          decision: screening.decision,
          wouldPostAction: screening.decision.post_action,
          actionExecuted: false,
          reasoningCaptured: screening.reasoningCaptured,
          dryRunModalStable: !drift
        };
        items.push(item);

        emitProgress("candidate_completed", `候选人已完成：${item.candidateLabel || `候选人 ${index + 1}`}`, {
          processedCandidates: items.length,
          screenableCandidates: items.length,
          llmCalls,
          currentCandidateLabel: item.candidateLabel || "",
          currentIndex: index + 1,
          lastItem: {
            index: item.index,
            status: item.status,
            candidateLabel: item.candidateLabel
          }
        });

        if (index >= candidateLimit - 1) break;
        const nextAction = await clickRecommendNextAndWait(client, snapshot.domHash);
        if (!nextAction.changed) {
          violations.push({
            code: "next_candidate_not_available",
            index,
            nextAction
          });
          break;
        }
        await sleep(stepDelayMs);
        await assertNotRiskPage(client, "推荐详情下一位后检查");
      }

      const closeAction = await closeRecommendModalVerified(client);
      const result = buildRecommendDryRunResult({
        candidateLimit,
        llmCalls,
        tabLabel,
        startIndex,
        stepDelayMs,
        maxPayloadChars,
        openAction,
        closeAction,
        violations,
        items
      });
      return {
        ...result,
        passed: evaluateRecommendDryRunScreening(result).passed
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
}

export function buildMockRecommendScreeningProvider({
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

export function summarizeRecommendDryRunScreening(result) {
  const evaluation = evaluateRecommendDryRunScreening(result);
  return {
    ok: Boolean(result?.passed),
    dryRun: Boolean(result?.dryRun),
    processedCandidates: result?.processedCandidates || 0,
    screenableCandidates: result?.screenableCandidates || 0,
    llmCalls: result?.llmCalls || 0,
    actionClicks: result?.actionClicks || 0,
    coveragePassed: evaluation.coveragePassed,
    closeVerified: Boolean(result?.closeAction?.closed),
    violations: evaluation.failures
  };
}

export function evaluateRecommendDryRunScreening(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  const requested = result?.requestedCandidateLimit || 0;
  const failures = Array.isArray(result?.violations) ? result.violations.map((item) => item.code || String(item)) : [];
  const uniqueTextHashes = new Set(items.map((item) => item.textHash).filter(Boolean));
  const coveragePassed = items.every((item) => item.coverage?.passed);

  if (!result?.dryRun) failures.push("not_dry_run");
  if (items.length < requested) failures.push("not_enough_candidates");
  if (uniqueTextHashes.size < items.length) failures.push("duplicate_candidates");
  if ((result?.llmCalls || 0) !== items.length) failures.push("llm_call_count_mismatch");
  if ((result?.actionClicks || 0) !== 0) failures.push("action_clicks_not_zero");
  if (!coveragePassed) failures.push("coverage_audit_failed");
  if (!result?.closeAction?.closed) failures.push("modal_not_closed");
  for (const item of items) {
    if (item.actionExecuted) failures.push(`candidate_${item.index}_action_executed`);
    if (!item.decision?.decision || !item.decision?.post_action) failures.push(`candidate_${item.index}_missing_decision`);
  }

  return {
    passed: failures.length === 0,
    coveragePassed,
    failures
  };
}

function buildRecommendDryRunProgressSnapshot(state = {}) {
  return {
    workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
    targetCandidates: Math.max(1, state.targetCandidates || 1),
    processedCandidates: state.processedCandidates || 0,
    screenableCandidates: state.screenableCandidates || 0,
    llmCalls: state.llmCalls || 0,
    actionClicks: state.actionClicks || 0,
    currentIndex: Number.isInteger(state.currentIndex) ? state.currentIndex : null,
    currentCandidateLabel: state.currentCandidateLabel || "",
    lastItem: state.lastItem || null
  };
}

function buildRecommendDryRunResult({
  candidateLimit,
  llmCalls,
  tabLabel,
  startIndex,
  stepDelayMs,
  maxPayloadChars,
  openAction,
  closeAction,
  violations,
  items,
  passed = null,
  stage = null,
  statusMessage = null
} = {}) {
  return {
    schemaVersion: RECOMMEND_DRY_RUN_SCHEMA_VERSION,
    dryRun: true,
    requestedCandidateLimit: candidateLimit,
    processedCandidates: items.length,
    screenableCandidates: items.length,
    llmCalls,
    actionClicks: 0,
    tabLabel,
    startIndex,
    stepDelayMs,
    maxPayloadChars,
    openAction,
    closeAction,
    stage,
    statusMessage,
    violations: [...violations],
    items: [...items],
    passed
  };
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
  return {
    ...result,
    active: await readActiveRecommendTab(client) === tabLabel || result.active
  };
}

async function readActiveRecommendTab(client) {
  return client.evaluate((selector) => {
    const getText = (node) => (node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
    const labels = [...document.querySelectorAll(selector)];
    const selected = labels.find((node) => String(node.closest(".ant-lpt-segmented-item")?.className || "").includes("selected"));
    return getText(selected);
  }, recommendSelectors.segmentedLabel);
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

async function clickRecommendNextAndWait(client, previousDomHash) {
  const clicked = await client.evaluate((selector) => {
    const button = document.querySelector(selector);
    if (!button) return { clicked: false, reason: "next_button_not_found" };
    button.click();
    return { clicked: true };
  }, recommendSelectors.nextButton);
  if (!clicked.clicked) return { ...clicked, changed: false };
  const changedHash = await client.waitFor((expectedHash) => {
    const root = document.querySelector('[class*="resume-detail-modal-wrap"] .resume-detail-content-body.printable-content');
    if (!root) return false;
    const text = (root.innerText || root.textContent || "").trim();
    if (text.length <= 100) return false;
    const hash = Array.from(text).reduce((accumulator, char) => ((accumulator << 5) - accumulator + char.charCodeAt(0)) | 0, 0).toString();
    return hash !== expectedHash ? hash : false;
  }, [previousDomHash], {
    timeoutMs: 12000,
    pollMs: 300
  });
  return {
    ...clicked,
    changed: Boolean(changedHash),
    changedHash: changedHash || ""
  };
}

async function closeRecommendModalVerified(client) {
  return closeRecommendModalToList(client);
}

async function resetRecommendListToTop(client) {
  await client.evaluate(() => {
    window.scrollTo(0, 0);
    window.dispatchEvent(new Event("scroll"));
  });
  await sleep(700);
}

async function ensureRecommendListReady(client) {
  const cleanup = await clearRecommendBlockingOverlaysToList(client);
  if (!cleanup.closed) {
    throw new Error(`推荐页存在未关闭遮罩，且无法通过关闭弹层返回列表：${cleanup.reason || "unknown"}`);
  }
}

export function detectDryRunModalDrift(beforeSnapshot, afterSnapshot, index) {
  if (!afterSnapshot) {
    return {
      code: "dry_run_after_snapshot_missing",
      index,
      beforeTextHash: beforeSnapshot.textHash
    };
  }
  const beforeIdentity = extractRecommendSnapshotIdentity(beforeSnapshot);
  const afterIdentity = extractRecommendSnapshotIdentity(afterSnapshot);
  if (
    beforeIdentity.resumeId
    && afterIdentity.resumeId
    && beforeIdentity.resumeId !== afterIdentity.resumeId
  ) {
    return {
      code: "dry_run_candidate_identity_changed",
      index,
      beforeIdentity,
      afterIdentity
    };
  }
  if (
    beforeIdentity.name
    && afterIdentity.name
    && beforeIdentity.name !== afterIdentity.name
  ) {
    return {
      code: "dry_run_candidate_identity_changed",
      index,
      beforeIdentity,
      afterIdentity
    };
  }
  return null;
}

function extractRecommendSnapshotIdentity(snapshot = {}) {
  const text = String(snapshot.fullText || "");
  const lines = text
    .split(/\r?\n+/u)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const viewImageIndex = lines.findIndex((line) => line === "查看大图");
  const resumeIdMatch = text.match(/简历编号\s*:?\s*([A-Za-z0-9]+)/u);
  return {
    name: viewImageIndex >= 0 ? lines[viewImageIndex + 1] || "" : "",
    resumeId: resumeIdMatch?.[1] || "",
    textHash: snapshot.textHash || ""
  };
}

async function assertNotRiskPage(client, actionLabel) {
  const currentUrl = await client.evaluate(() => location.href);
  if (isLiepinRiskPageUrl(currentUrl)) {
    throw new Error(`检测到猎聘风控/验证码页，已停止${actionLabel}：${currentUrl}`);
  }
}
