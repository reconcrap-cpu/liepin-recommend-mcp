import { createPageClient, discoverLiepinPages, isCdpRuntimeTimeoutError } from "../chrome.js";
import { DEFAULT_DEBUG_PORT, RUN_WORKFLOWS } from "../constants.js";
import { runStructuredScreening, SCREENING_MODES } from "../llm-adapter.js";
import { isAllCandidateLimit, normalizeText, parsePositiveInteger, sleep } from "../utils.js";
import { activateAndReadChatRow, readResumeDetailSnapshot } from "./chat-sampler.js";
import {
  CHAT_MAX_CONTACTS_SELECTOR,
  clickChatElementByMouse,
  dispatchMouseClick,
  ensureChatUnreadFilter,
  readChatListSnapshot,
  resetChatListToTop,
  scrollChatListByPage,
  selectChatJob
} from "./chat-options.js";
import { classifyChatScreeningEligibility } from "./chat-state-policy.js";
import { buildCvScreeningInput, auditCvPayloadCoverage } from "./cv-payload.js";
import { assertPageRuntimeResponsive } from "./page-health.js";
import { pressEscapeKey } from "./recommend-return.js";
import { chatSelectors } from "./selectors.js";
import { normalizeSnapshot } from "./snapshot.js";

export const CHAT_SCREENING_SCHEMA_VERSION = "liepin_chat_screening_v1";

export async function runChatScreening({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  candidateLimit,
  scanLimit = null,
  jobTitle,
  unreadOnly,
  criteria = null,
  maxPayloadChars = null,
  config = null,
  provider = null,
  onProgress = null
} = {}) {
  if (candidateLimit === undefined) {
    throw new Error("chat_screening 需要 candidate_limit，且必须为正整数或 all。");
  }
  const scanAllCandidates = candidateLimit === null || isAllCandidateLimit(candidateLimit);
  const requestedCandidateLimit = scanAllCandidates
    ? null
    : parsePositiveInteger(candidateLimit, null);
  if (!scanAllCandidates && !requestedCandidateLimit) {
    throw new Error("chat_screening 需要 candidate_limit，且必须为正整数或 all。");
  }
  const normalizedJobTitle = normalizeText(jobTitle);
  if (!normalizedJobTitle) {
    throw new Error("chat_screening 需要 job，请先调用 liepin_chat_options 让用户选择岗位。");
  }
  if (typeof unreadOnly !== "boolean") {
    throw new Error("chat_screening 需要 unread_only，true 表示只扫未读，false 表示扫全部。");
  }
  const normalizedCriteria = normalizeText(criteria);
  if (!normalizedCriteria) {
    throw new Error("chat_screening 需要 criteria。");
  }

  const requestedScanLimit = parsePositiveInteger(scanLimit, null);
  const pages = await discoverLiepinPages({ port });
  if (!pages.chat) {
    throw new Error(`未找到猎聘聊天页，请先在 Chrome ${port} 打开 https://lpt.liepin.com/chat/im`);
  }
  const client = await createPageClient(pages.chat);
  try {
    const items = [];
    const violations = [];
    const seenRows = new Set();
    let observedRows = 0;
    let processedCandidates = 0;
    let screenableCandidates = 0;
    let llmCalls = 0;
    let actionClicks = 0;
    let requestResumeSuccesses = 0;
    let scrollPasses = 0;
    let stopReason = "";
    const progressState = {
      targetCandidates: requestedCandidateLimit,
      scanAllCandidates,
      scanLimit: requestedScanLimit,
      observedRows: 0,
      processedCandidates: 0,
      screenableCandidates: 0,
      llmCalls: 0,
      actionClicks: 0,
      requestResumeSuccesses: 0,
      skippedRows: 0,
      currentRowIndex: null,
      currentRowKey: "",
      currentResumeState: "",
      lastItem: null
    };
    const buildPartialWorkflowResult = (stage, statusMessage) => {
      const result = buildChatScreeningResult({
        requestedCandidateLimit,
        requestedScanLimit,
        jobTitle: normalizedJobTitle,
        unreadOnly,
        criteria: normalizedCriteria,
        observedRows,
        processedCandidates,
        screenableCandidates,
        llmCalls,
        actionClicks,
        requestResumeSuccesses,
        scrollPasses,
        stopReason,
        violations,
        items,
        stage,
        statusMessage,
        passed: false
      });
      return {
        workflow: RUN_WORKFLOWS.CHAT_SCREENING,
        summary: summarizeChatScreening(result),
        result
      };
    };
    const emitProgress = (stage, statusMessage, patch = {}) => {
      Object.assign(progressState, patch);
      if (typeof onProgress !== "function") return;
      onProgress({
        stage,
        statusMessage,
        progress: buildChatScreeningProgressSnapshot(progressState),
        partialResult: buildPartialWorkflowResult(stage, statusMessage)
      });
    };

    try {
      await assertPageRuntimeResponsive(client, { pageName: "猎聘聊天页" });
      emitProgress("prepare_chat_page", "正在设置聊天页岗位和未读筛选");
      await prepareChatPageForScreening(client, {
        jobTitle: normalizedJobTitle,
        unreadOnly,
        resetToTop: true
      });
      await sleep(600);

      emitProgress("scan_chat_list", "开始扫描聊天候选人", {
        observedRows,
        processedCandidates,
        requestResumeSuccesses
      });

      let idleScrollPasses = 0;
      while (scanAllCandidates || requestResumeSuccesses < requestedCandidateLimit) {
        if (requestedScanLimit && processedCandidates >= requestedScanLimit) {
          stopReason = "scan_limit_reached";
          break;
        }
        const snapshot = await readChatListSnapshot(client);
        const rowCount = snapshot.rowCount || 0;
        let newRowsThisWindow = 0;
        let restartedAfterRefresh = false;
        let stopAfterRecoveryFailure = false;

        for (let index = 0; index < rowCount && (scanAllCandidates || requestResumeSuccesses < requestedCandidateLimit); index += 1) {
          if (requestedScanLimit && processedCandidates >= requestedScanLimit) {
            stopReason = "scan_limit_reached";
            break;
          }
          emitProgress("open_chat_row", `正在处理聊天行 ${index + 1}/${rowCount}`, {
            currentRowIndex: index
          });
          const state = await activateAndReadChatRow(client, index);
          if (!state) break;
          if (seenRows.has(state.rowKey)) continue;
          seenRows.add(state.rowKey);
          observedRows += 1;
          newRowsThisWindow += 1;

          if (state.rowType !== "candidate") {
            const item = buildSkippedItem(state, {
              reason: "non_candidate_row",
              llmCalled: false
            });
            items.push(item);
            emitProgress("candidate_completed", `跳过非候选人行：${state.rowKey}`, {
              observedRows,
              skippedRows: countSkippedRows(items),
              currentRowIndex: state.rowIndex,
              currentRowKey: state.rowKey || "",
              currentResumeState: state.resumeState || "",
              lastItem: summarizeChatScreeningProgressItem(item)
            });
            continue;
          }

          processedCandidates += 1;
          const eligibility = classifyChatScreeningEligibility(state);
          if (!eligibility.shouldCallLlm) {
            const item = buildSkippedItem(state, {
              reason: eligibility.skipReason || "not_screenable",
              eligibility,
              llmCalled: false
            });
            items.push(item);
            emitProgress("candidate_completed", `候选人跳过：${state.rowKey}`, {
              observedRows,
              processedCandidates,
              skippedRows: countSkippedRows(items),
              currentRowIndex: state.rowIndex,
              currentRowKey: state.rowKey || "",
              currentResumeState: state.resumeState || "",
              lastItem: summarizeChatScreeningProgressItem(item)
            });
            continue;
          }

          screenableCandidates += 1;
          emitProgress("open_resume_modal", `正在打开简历：${state.rowKey || `row-${state.rowIndex}`}`, {
            observedRows,
            processedCandidates,
            screenableCandidates,
            currentRowIndex: state.rowIndex,
            currentRowKey: state.rowKey || "",
            currentResumeState: state.resumeState || ""
          });
          const resumeCapture = await openReadAndCloseResumeModal(client, state, {
            maxPayloadChars
          });
          if (resumeCapture.close && !resumeCapture.close.closed) {
            throw new Error(`简历详情弹窗关闭失败：${state.rowKey || state.rowIndex || ""}`);
          }
          if (resumeCapture.refreshedBeforeOpen) {
            const item = buildSkippedItem(state, {
              reason: "page_refreshed_before_resume_open",
              llmCalled: false
            });
            items.push(item);
            const recovery = await recoverChatPageAfterRefresh(client, {
              jobTitle: normalizedJobTitle,
              unreadOnly,
              emitProgress,
              statusMessage: "页面刷新后正在重新应用岗位和未读筛选"
            });
            if (!recovery.ok) {
              stopReason = "chat_page_recovery_failed";
              violations.push({
                code: "chat_page_recovery_failed",
                rowKey: state.rowKey,
                rowIndex: state.rowIndex,
                error: recovery.error
              });
              stopAfterRecoveryFailure = true;
              emitProgress("candidate_completed", `页面刷新后恢复聊天页失败，已保留当前结果并停止：${recovery.error?.message || ""}`, {
                observedRows,
                processedCandidates,
                screenableCandidates,
                skippedRows: countSkippedRows(items),
                currentRowIndex: state.rowIndex,
                currentRowKey: state.rowKey || "",
                currentResumeState: state.resumeState || "",
                lastItem: summarizeChatScreeningProgressItem(item)
              });
              break;
            }
            restartedAfterRefresh = true;
            idleScrollPasses = 0;
            emitProgress("candidate_completed", `页面刷新后跳过当前候选人并继续：${state.rowKey}`, {
              observedRows,
              processedCandidates,
              screenableCandidates,
              skippedRows: countSkippedRows(items),
              currentRowIndex: state.rowIndex,
              currentRowKey: state.rowKey || "",
              currentResumeState: state.resumeState || "",
              lastItem: summarizeChatScreeningProgressItem(item)
            });
            break;
          }
          const pageRefreshedAfterResumeRead = didRefreshPage(resumeCapture.close);
          const screenInput = resumeCapture.screenInput;
          emitProgress("chat_llm", `正在评估完整简历：${state.rowKey || `row-${state.rowIndex}`}`, {
            observedRows,
            processedCandidates,
            screenableCandidates,
            currentRowIndex: state.rowIndex,
            currentRowKey: state.rowKey || "",
            currentResumeState: state.resumeState || ""
          });
          const screening = await runStructuredScreening({
            mode: SCREENING_MODES.CHAT,
            screenInput,
            criteria: normalizedCriteria,
            operatorFilters: buildChatOperatorFilters({
              jobTitle: normalizedJobTitle,
              unreadOnly
            }),
            config,
            provider
          });
          llmCalls += 1;

          let chatAction = {
            action: "none",
            executed: false,
            clicked: false,
            ok: true,
            status: "no_action_requested"
          };
          let status = "screened_no_action";
          if (shouldRequestResumeForDecision(screening.decision)) {
            if (pageRefreshedAfterResumeRead) {
              chatAction = {
                action: "request_resume",
                executed: false,
                clicked: false,
                ok: true,
                status: "skipped_after_page_refresh",
                before: state,
                after: state
              };
              status = "screened_action_skipped_after_refresh";
            } else {
              emitProgress("request_resume", `正在索要简历：${state.rowKey || `row-${state.rowIndex}`}`, {
                observedRows,
                processedCandidates,
                screenableCandidates,
                llmCalls,
                currentRowIndex: state.rowIndex,
                currentRowKey: state.rowKey || "",
                currentResumeState: state.resumeState || ""
              });
              chatAction = await requestResumeWithRetry(client, {
                beforeState: state,
                maxAttempts: 3
              });
              actionClicks += chatAction.clickedAttempts || 0;
              if (chatAction.ok) {
                requestResumeSuccesses += 1;
                status = "request_resume_succeeded";
              } else {
                status = "request_resume_failed";
                violations.push({
                  code: "request_resume_failed",
                  rowKey: state.rowKey,
                  rowIndex: state.rowIndex,
                  attempts: chatAction.attempts || []
                });
              }
            }
          }

          const item = {
            index: state.rowIndex,
            rowKey: state.rowKey,
            rowIndex: state.rowIndex,
            rowType: state.rowType,
            resumeState: state.resumeState,
            status,
            llmCalled: true,
            chatLlmCalled: true,
            llmRequest: screening.request,
            decision: screening.decision,
            chatDecision: screening.decision,
            wouldPostAction: screening.decision.post_action,
            actionExecuted: Boolean(chatAction.executed),
            chatAction,
            beforeState: state,
            afterState: chatAction.after || state,
            candidate: screenInput.candidate || {},
            candidateLabel: resumeCapture.snapshot?.candidateLabel || screenInput.candidate?.label || "",
            manifest: screenInput.manifest,
            inputManifest: screenInput.manifest,
            chatInputManifest: screenInput.manifest,
            payloadCoverage: resumeCapture.payloadCoverage,
            resumeSnapshot: resumeCapture.snapshot,
            reasoningCaptured: screening.reasoningCaptured,
            reasoningText: screening.reasoningText || "",
            chatReasoningText: screening.reasoningText || ""
          };
          items.push(item);
          emitProgress("candidate_completed", `候选人已完成：${state.rowKey || `row-${state.rowIndex}`}`, {
            observedRows,
            processedCandidates,
            screenableCandidates,
            skippedRows: countSkippedRows(items),
            llmCalls,
            actionClicks,
            requestResumeSuccesses,
            currentRowIndex: state.rowIndex,
            currentRowKey: state.rowKey || "",
            currentResumeState: state.resumeState || "",
            lastItem: summarizeChatScreeningProgressItem(item)
          });
          if (pageRefreshedAfterResumeRead) {
            const recovery = await recoverChatPageAfterRefresh(client, {
              jobTitle: normalizedJobTitle,
              unreadOnly,
              emitProgress,
              statusMessage: "页面刷新后正在重新应用岗位和未读筛选"
            });
            if (!recovery.ok) {
              stopReason = "chat_page_recovery_failed";
              violations.push({
                code: "chat_page_recovery_failed",
                rowKey: state.rowKey,
                rowIndex: state.rowIndex,
                error: recovery.error
              });
              stopAfterRecoveryFailure = true;
              emitProgress("candidate_completed", `页面刷新后恢复聊天页失败，已保留当前结果并停止：${recovery.error?.message || ""}`, {
                observedRows,
                processedCandidates,
                screenableCandidates,
                skippedRows: countSkippedRows(items),
                llmCalls,
                actionClicks,
                requestResumeSuccesses,
                currentRowIndex: state.rowIndex,
                currentRowKey: state.rowKey || "",
                currentResumeState: state.resumeState || "",
                lastItem: summarizeChatScreeningProgressItem(item)
              });
              break;
            }
            restartedAfterRefresh = true;
            idleScrollPasses = 0;
            break;
          }
        }

        if (stopAfterRecoveryFailure) {
          break;
        }
        if (restartedAfterRefresh) {
          continue;
        }
        if (!scanAllCandidates && requestResumeSuccesses >= requestedCandidateLimit) {
          stopReason = "candidate_limit_reached";
          break;
        }
        if (requestedScanLimit && processedCandidates >= requestedScanLimit) {
          stopReason = "scan_limit_reached";
          break;
        }
        const latestSnapshot = await readChatListSnapshot(client);
        const preScrollStopReason = resolveChatScreeningScrollStopReason({
          latestSnapshot
        });
        if (preScrollStopReason) {
          stopReason = preScrollStopReason;
          break;
        }
        const scroll = await scrollChatListByPage(client);
        scrollPasses += 1;
        await sleep(900);
        if (!scroll.moved && newRowsThisWindow === 0) {
          idleScrollPasses += 1;
        } else {
          idleScrollPasses = 0;
        }
        const scrollStopReason = resolveChatScreeningScrollStopReason({
          scroll,
          idleScrollPasses
        });
        if (scrollStopReason) {
          stopReason = scrollStopReason;
          break;
        }
      }

      if (!stopReason) {
        stopReason = !scanAllCandidates && requestResumeSuccesses >= requestedCandidateLimit
          ? "candidate_limit_reached"
          : "completed";
      }
      const result = buildChatScreeningResult({
        requestedCandidateLimit,
        requestedScanLimit,
        jobTitle: normalizedJobTitle,
        unreadOnly,
        criteria: normalizedCriteria,
        observedRows,
        processedCandidates,
        screenableCandidates,
        llmCalls,
        actionClicks,
        requestResumeSuccesses,
        scrollPasses,
        stopReason,
        violations,
        items
      });
      const completedRequestedScope = scanAllCandidates
        ? stopReason !== "scan_limit_reached"
        : requestResumeSuccesses >= requestedCandidateLimit;
      return {
        ...result,
        passed: completedRequestedScope && violations.length === 0
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

export function summarizeChatScreening(result = {}) {
  return {
    ok: Boolean(result.passed),
    dryRun: false,
    job: result.jobTitle || "",
    unreadOnly: Boolean(result.unreadOnly),
    targetRequestResumeSuccesses: result.requestedCandidateLimit ?? null,
    requestResumeSuccesses: result.requestResumeSuccesses || 0,
    processedCandidates: result.processedCandidates || 0,
    screenableCandidates: result.screenableCandidates || 0,
    skippedRows: result.skippedRows || 0,
    llmCalls: result.llmCalls || 0,
    actionClicks: result.actionClicks || 0,
    stopReason: result.stopReason || "",
    violations: result.violations || []
  };
}

export function resolveChatScreeningScrollStopReason({
  latestSnapshot = null,
  scroll = null,
  idleScrollPasses = 0
} = {}) {
  if (latestSnapshot?.maxContactsVisible || scroll?.maxContactsVisible) {
    return "max_contacts_reached";
  }
  if (latestSnapshot?.atBottom || scroll?.atBottom) {
    return "list_bottom_reached";
  }
  if (idleScrollPasses >= 2) {
    return "no_scroll_progress";
  }
  return "";
}

export function shouldRequestResumeForDecision(decision = {}) {
  return decision?.decision === "pass" && decision?.post_action === "request_resume";
}

export function isChatRequestSuccessState(before = {}, after = {}) {
  const afterState = normalizeResumeActionState(after.resumeState);
  if (afterState === "索要中") return true;
  const beforeCount = before.successMessageCount || 0;
  const afterCount = after.successMessageCount || 0;
  return afterCount > beforeCount && Boolean(after.latestSuccessMessage);
}

export async function openReadAndCloseResumeModal(client, state = {}, {
  maxPayloadChars = null
} = {}) {
  const staleClose = await closeResumeDetailModal(client, { reloadOnFailure: true });
  if (didRefreshPage(staleClose)) {
    return {
      refreshedBeforeOpen: true,
      staleClose,
      close: staleClose,
      openClick: null,
      openAttempts: [],
      snapshot: null,
      screenInput: null,
      payloadCoverage: null
    };
  }
  const openAttempt = await openResumeDetailModal(client);
  if (!openAttempt.ready) {
    throw new Error(`简历详情弹窗未出现：${state.rowKey || state.rowIndex || ""}；openAttempts=${JSON.stringify(openAttempt.attempts)}`);
  }
  let snapshot = null;
  let result = null;
  try {
    snapshot = normalizeSnapshot(await readResumeDetailSnapshot(client));
    const screenInput = buildCvScreeningInput(snapshot, { maxPayloadChars });
    const payloadCoverage = auditCvPayloadCoverage(snapshot, { maxPayloadChars });
    result = {
      openClick: openAttempt.openClick,
      openAttempts: openAttempt.attempts,
      staleClose,
      snapshot,
      screenInput,
      payloadCoverage
    };
    return result;
  } finally {
    const close = await closeResumeDetailModal(client, { reloadOnFailure: true });
    if (result) result.close = close;
  }
}

function didRefreshPage(closeResult = {}) {
  return String(closeResult?.closeMethod || "").includes("reload")
    || closeResult?.attempts?.some((attempt) => attempt.method === "reload") === true;
}

async function openResumeDetailModal(client) {
  const attempts = [];
  const targets = [
    {
      selector: chatSelectors.viewResumeButton,
      method: "view_resume_button_mouse",
      click: () => clickChatElementByMouse(client, chatSelectors.viewResumeButton)
    },
    {
      selector: chatSelectors.viewResumeButton,
      method: "view_resume_button_dom",
      click: () => clickChatElementByDom(client, chatSelectors.viewResumeButton, {
        childSelector: "button"
      })
    },
    {
      selector: chatSelectors.chatHeaderResumeContent,
      method: "chat_header_resume_content_mouse",
      click: () => clickChatElementByMouse(client, chatSelectors.chatHeaderResumeContent)
    },
    {
      selector: chatSelectors.chatHeaderResumeContent,
      method: "chat_header_resume_content_dom",
      click: () => clickChatElementByDom(client, chatSelectors.chatHeaderResumeContent)
    }
  ];

  for (const target of targets) {
    const click = await target.click();
    const ready = click.clicked
      ? await waitForResumeDetailContent(client, { timeoutMs: 10000 })
      : null;
    const attempt = {
      method: target.method,
      selector: target.selector,
      click,
      ready: Boolean(ready),
      readyState: ready || null
    };
    attempts.push(attempt);
    if (ready) {
      return {
        ready: true,
        openClick: {
          ...click,
          openMethod: target.method
        },
        attempts
      };
    }
  }

  return {
    ready: false,
    openClick: null,
    attempts
  };
}

async function clickChatElementByDom(client, selector, {
  childSelector = null
} = {}) {
  return client.evaluate(({ selector: targetSelector, childSelector: targetChildSelector }) => {
    const root = document.querySelector(targetSelector);
    const node = targetChildSelector
      ? root?.querySelector(targetChildSelector) || root
      : root;
    if (!node) {
      return {
        clicked: false,
        method: "dom",
        reason: "target_not_found",
        selector: targetSelector
      };
    }
    const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    node.click();
    return {
      clicked: true,
      method: "dom",
      selector: targetSelector,
      target: {
        tag: node.tagName,
        text,
        className: String(node.className || "")
      }
    };
  }, {
    selector,
    childSelector
  });
}

async function waitForResumeDetailContent(client, {
  timeoutMs = 10000
} = {}) {
  return client.waitFor((selectors) => {
    const root = document.querySelector(selectors.resumeDetailModalPrintable);
    if (!isVisible(root)) return false;
    const text = (root.innerText || root.textContent || "").replace(/\s+/g, " ").trim();
    const htmlLength = root.innerHTML.length;
    if (text.length < 20) return false;
    return {
      textLength: text.length,
      htmlLength
    };

    function isVisible(node) {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    }
  }, [chatSelectors], {
    timeoutMs,
    pollMs: 250
  });
}

export async function closeResumeDetailModal(client, {
  reloadOnFailure = false
} = {}) {
  const before = await safeReadResumeDetailModalState(client);
  if (before.runtimeTimedOut && reloadOnFailure) {
    await client.send("Page.reload", { ignoreCache: false });
    await sleep(1200);
    const listReady = await client.waitFor((selector) => Boolean(document.querySelector(selector)), [chatSelectors.conversationRow], {
      timeoutMs: 10000,
      pollMs: 250
    });
    return {
      clicked: false,
      closed: Boolean(listReady),
      closeMethod: "reload_after_runtime_timeout",
      attempts: [{ clicked: false, method: "reload", listReady: Boolean(listReady) }],
      before,
      after: await safeReadResumeDetailModalState(client)
    };
  }
  if (!before.open) {
    return {
      clicked: false,
      closed: true,
      closeMethod: "already_closed",
      before
    };
  }

  const attempts = [];
  let click = await clickResumeDetailCloseControlByMouse(client);
  attempts.push(click);
  let closeMethod = click.clicked ? "mouse" : "";
  let closed = await waitForResumeDetailClosed(client, 2500);

  if (!closed) {
    const domClick = await clickResumeDetailCloseControlByDom(client);
    attempts.push(domClick);
    if (domClick.clicked) {
      closeMethod = closeMethod ? `${closeMethod}+dom` : "dom";
    }
    closed = await waitForResumeDetailClosed(client, 2500);
  }

  if (!closed) {
    await pressEscapeKey(client);
    attempts.push({ clicked: true, method: "escape" });
    closeMethod = closeMethod ? `${closeMethod}+escape` : "escape";
    closed = await waitForResumeDetailClosed(client, 2500);
  }

  if (!closed && reloadOnFailure) {
    await client.send("Page.reload", { ignoreCache: false });
    await sleep(1200);
    const listReady = await client.waitFor((selector) => Boolean(document.querySelector(selector)), [chatSelectors.conversationRow], {
      timeoutMs: 10000,
      pollMs: 250
    });
    closed = await waitForResumeDetailClosed(client, 3000);
    attempts.push({
      clicked: false,
      method: "reload",
      listReady: Boolean(listReady)
    });
    closeMethod = closeMethod ? `${closeMethod}+reload` : "reload";
  }

  return {
    clicked: attempts.some((attempt) => attempt.clicked),
    closed: Boolean(closed),
    closeMethod,
    attempts,
    before,
    after: await safeReadResumeDetailModalState(client)
  };
}

async function clickResumeDetailCloseControlByMouse(client) {
  const target = await client.evaluate((selectors) => {
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const controls = [...document.querySelectorAll(selectors.resumeDetailModalCloseButton)]
      .filter(visible);
    const closeButtons = controls.filter((node) => String(node.className || "").includes("closeBtn"));
    const node = closeButtons.at(-1) || controls.at(-1);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      tag: node.tagName,
      className: String(node.className || "")
    };
  }, chatSelectors);
  if (!target) {
    return {
      clicked: false,
      method: "mouse",
      reason: "resume_modal_close_not_found"
    };
  }
  await dispatchMouseClick(client, target);
  return {
    clicked: true,
    method: "mouse",
    target
  };
}

async function clickResumeDetailCloseControlByDom(client) {
  return client.evaluate((selectors) => {
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const controls = [...document.querySelectorAll(selectors.resumeDetailModalCloseButton)]
      .filter(visible);
    const closeButtons = controls.filter((node) => String(node.className || "").includes("closeBtn"));
    const node = closeButtons.at(-1) || controls.at(-1);
    if (!node) {
      return {
        clicked: false,
        method: "dom",
        reason: "resume_modal_close_not_found"
      };
    }
    node.click();
    return {
      clicked: true,
      method: "dom",
      tag: node.tagName,
      className: String(node.className || "")
    };
  }, chatSelectors);
}

async function waitForResumeDetailClosed(client, timeoutMs) {
  return client.waitFor((selectors) => {
    return ![...document.querySelectorAll(selectors.resumeDetailModalRoot)]
      .some((node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0;
      });
  }, [chatSelectors], {
    timeoutMs,
    pollMs: 150
  });
}

async function readResumeDetailModalState(client) {
  return client.evaluate((selectors) => {
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const roots = [...document.querySelectorAll(selectors.resumeDetailModalRoot)];
    const visibleRoots = roots.filter(visible);
    return {
      open: visibleRoots.length > 0,
      rootCount: roots.length,
      visibleRootCount: visibleRoots.length
    };
  }, chatSelectors);
}

async function safeReadResumeDetailModalState(client) {
  try {
    return await readResumeDetailModalState(client);
  } catch (error) {
    return {
      open: false,
      rootCount: null,
      visibleRootCount: null,
      runtimeTimedOut: isCdpRuntimeTimeoutError(error),
      error: {
        message: error?.message || String(error)
      }
    };
  }
}

export async function requestResumeWithRetry(client, {
  beforeState = null,
  maxAttempts = 3,
  clickSettleMs = 600,
  verifyDelayMs = 500,
  retryDelayMs = 500
} = {}) {
  const attempts = [];
  let clickedAttempts = 0;
  let baseline = await readChatRequestResumeState(client);
  if (normalizeResumeActionState(baseline.resumeState) === "索要中") {
    return {
      action: "request_resume",
      executed: false,
      clicked: false,
      clickedAttempts,
      attempts,
      before: beforeState || baseline,
      after: {
        ...(beforeState || {}),
        resumeState: "索要中"
      },
      verification: baseline,
      ok: true,
      status: "already_requesting"
    };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = await readChatRequestResumeState(client);
    if (normalizeResumeActionState(before.resumeState) === "索要中") {
      return {
        action: "request_resume",
        executed: attempts.length > 0,
        clicked: clickedAttempts > 0,
        clickedAttempts,
        attempts,
        before: beforeState || baseline,
        after: {
          ...(beforeState || {}),
          resumeState: "索要中"
        },
        verification: before,
        ok: true,
        status: "button_already_requesting"
      };
    }
    if (normalizeResumeActionState(before.resumeState) !== "索要简历") {
      attempts.push({
        attempt,
        clicked: false,
        ok: false,
        before,
        reason: "request_resume_button_not_available"
      });
      return {
        action: "request_resume",
        executed: false,
        clicked: clickedAttempts > 0,
        clickedAttempts,
        attempts,
        before: beforeState || baseline,
        after: beforeState || before,
        verification: before,
        ok: false,
        status: "request_resume_button_not_available"
      };
    }

    let click = await clickChatElementByMouse(client, chatSelectors.resumeActionButton, {
      text: "索要简历"
    });
    if (!click.clicked) {
      click = await clickChatElementByMouse(client, chatSelectors.specialBrowseButton, {
        text: "索要简历"
      });
    }
    if (click.clicked) clickedAttempts += 1;
    await sleep(clickSettleMs);
    const confirmation = await confirmResumeRequestIfPresent(client);
    await sleep(verifyDelayMs);
    const after = await readChatRequestResumeState(client);
    const ok = isChatRequestSuccessState(before, after);
    attempts.push({
      attempt,
      clicked: Boolean(click.clicked),
      click,
      confirmation,
      before,
      after,
      ok
    });
    if (ok) {
      return {
        action: "request_resume",
        executed: true,
        clicked: clickedAttempts > 0,
        clickedAttempts,
        attempts,
        before: beforeState || baseline,
        after: {
          ...(beforeState || {}),
          resumeState: normalizeResumeActionState(after.resumeState)
        },
        verification: after,
        ok: true,
        status: "request_resume_succeeded"
      };
    }
    baseline = before;
    await sleep(retryDelayMs);
  }

  const finalState = await readChatRequestResumeState(client);
  return {
    action: "request_resume",
    executed: clickedAttempts > 0,
    clicked: clickedAttempts > 0,
    clickedAttempts,
    attempts,
    before: beforeState || baseline,
    after: {
      ...(beforeState || {}),
      resumeState: normalizeResumeActionState(finalState.resumeState)
    },
    verification: finalState,
    ok: isChatRequestSuccessState(baseline, finalState),
    status: isChatRequestSuccessState(baseline, finalState)
      ? "request_resume_succeeded_after_retry"
      : "request_resume_retry_exhausted"
  };
}

export async function readChatRequestResumeState(client) {
  const state = await client.evaluate((selectors) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const resumeButton = document.querySelector(selectors.resumeActionButton);
    const exactStateText = [...document.querySelectorAll(selectors.specialBrowseButton)]
      .map((node) => getText(node))
      .find((text) => ["索要简历", "索要中", "已向对方索要"].includes(text));
    const successMessages = [...document.querySelectorAll(selectors.requestResumeSuccessMessage)]
      .map((node) => getText(node))
      .filter((text) => text.includes("我想要一份你的简历"));
    return {
      resumeState: resumeButton ? getText(resumeButton) : (exactStateText || "UNKNOWN"),
      successMessageCount: successMessages.length,
      latestSuccessMessage: successMessages[0] || "",
      allSuccessMessages: successMessages.slice(0, 5)
    };
  }, chatSelectors);
  return {
    ...state,
    resumeState: normalizeResumeActionState(state.resumeState)
  };
}

export async function confirmResumeRequestIfPresent(client) {
  const target = await client.evaluate((selectors) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const compactText = (node) => getText(node).replace(/\s+/g, "");
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const modal = [...document.querySelectorAll(selectors.requestResumeConfirmModal)]
      .find((node) => visible(node) && /确定向对方索要简历吗/u.test(getText(node)));
    if (!modal) return { present: false };
    const buttons = [...modal.querySelectorAll("button")]
      .filter((node) => visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true");
    const button = buttons.find((node) => compactText(node) === "确定")
      || buttons.find((node) => compactText(node).includes("确定") && String(node.className || "").includes("primary"));
    if (!button) {
      return {
        present: true,
        clicked: false,
        reason: "confirm_button_not_found",
        modalText: getText(modal),
        buttonTexts: buttons.map((node) => getText(node))
      };
    }
    const rect = button.getBoundingClientRect();
    return {
      present: true,
      clicked: false,
      target: {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        text: getText(button),
        className: String(button.className || "")
      }
    };
  }, chatSelectors);
  if (!target.present) return { present: false, clicked: false };
  if (!target.target) return target;
  await dispatchMouseClick(client, target.target);
  const modalClosed = await client.waitFor((selectors) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    return ![...document.querySelectorAll(selectors.requestResumeConfirmModal)]
      .some((node) => visible(node) && /确定向对方索要简历吗/u.test(getText(node)));
  }, [chatSelectors], {
    timeoutMs: 3000,
    pollMs: 150
  });
  return {
    present: true,
    clicked: true,
    clickedBy: "mouse",
    clickedText: target.target.text,
    clickedClass: target.target.className,
    modalClosed: Boolean(modalClosed)
  };
}

function buildChatOperatorFilters({ jobTitle, unreadOnly }) {
  return [
    `chat_job=${jobTitle}`,
    `unread_only=${unreadOnly ? "true" : "false"}`,
    `terminal_selector=${CHAT_MAX_CONTACTS_SELECTOR}`
  ].join("\n");
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
    chatLlmCalled: false,
    actionExecuted: false
  };
}

async function prepareChatPageForScreening(client, {
  jobTitle,
  unreadOnly,
  resetToTop = false
} = {}) {
  const jobSelection = await selectChatJob(client, jobTitle);
  if (!jobSelection.ok) {
    throw new Error(`岗位选择失败：${jobTitle}`);
  }
  const unreadSelection = await ensureChatUnreadFilter(client, unreadOnly);
  if (!unreadSelection.ok) {
    throw new Error(`未读筛选设置失败：目标 unread_only=${unreadOnly}`);
  }
  const ready = await client.waitFor((selector) => Boolean(document.querySelector(selector)), [chatSelectors.conversationRow], {
    timeoutMs: 10000,
    pollMs: 250
  });
  if (!ready) throw new Error("聊天列表未出现");
  const reset = resetToTop
    ? await resetChatListToTop(client)
    : null;
  return {
    jobSelection,
    unreadSelection,
    ready: Boolean(ready),
    reset
  };
}

async function recoverChatPageAfterRefresh(client, {
  jobTitle,
  unreadOnly,
  emitProgress = null,
  statusMessage = "页面刷新后正在重新应用岗位和未读筛选"
} = {}) {
  if (typeof emitProgress === "function") {
    emitProgress("prepare_chat_page", statusMessage);
  }
  try {
    const prepared = await prepareChatPageForScreening(client, {
      jobTitle,
      unreadOnly,
      resetToTop: false
    });
    await sleep(600);
    return {
      ok: true,
      prepared
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "CHAT_PAGE_RECOVERY_FAILED",
        message: error?.message || String(error)
      }
    };
  }
}

function buildChatScreeningProgressSnapshot(state = {}) {
  return {
    workflow: RUN_WORKFLOWS.CHAT_SCREENING,
    targetCandidates: state.scanAllCandidates ? null : Math.max(1, state.targetCandidates || 1),
    scanAllCandidates: Boolean(state.scanAllCandidates),
    scanLimit: state.scanLimit || null,
    observedRows: state.observedRows || 0,
    processedCandidates: state.processedCandidates || 0,
    screenableCandidates: state.screenableCandidates || 0,
    skippedRows: state.skippedRows || 0,
    llmCalls: state.llmCalls || 0,
    actionClicks: state.actionClicks || 0,
    requestResumeSuccesses: state.requestResumeSuccesses || 0,
    currentRowIndex: Number.isInteger(state.currentRowIndex) ? state.currentRowIndex : null,
    currentRowKey: state.currentRowKey || "",
    currentResumeState: state.currentResumeState || "",
    lastItem: state.lastItem || null
  };
}

function summarizeChatScreeningProgressItem(item = {}) {
  return {
    index: Number.isInteger(item.index) ? item.index : null,
    rowIndex: Number.isInteger(item.rowIndex) ? item.rowIndex : null,
    rowKey: item.rowKey || "",
    status: item.status || "",
    resumeState: item.resumeState || "",
    reason: item.reason || "",
    chatActionStatus: item.chatAction?.status || ""
  };
}

function buildChatScreeningResult({
  requestedCandidateLimit,
  requestedScanLimit,
  jobTitle,
  unreadOnly,
  criteria,
  observedRows,
  processedCandidates,
  screenableCandidates,
  llmCalls,
  actionClicks,
  requestResumeSuccesses,
  scrollPasses,
  stopReason,
  violations,
  items,
  stage = null,
  statusMessage = null,
  passed = null
} = {}) {
  return {
    schemaVersion: CHAT_SCREENING_SCHEMA_VERSION,
    workflow: RUN_WORKFLOWS.CHAT_SCREENING,
    dryRun: false,
    jobTitle,
    unreadOnly,
    criteria,
    requestedCandidateLimit,
    scanAllCandidates: requestedCandidateLimit === null,
    requestedScanLimit,
    observedRows,
    processedCandidates,
    screenableCandidates,
    skippedRows: countSkippedRows(items),
    llmCalls,
    actionClicks,
    requestResumeSuccesses,
    scrollPasses,
    stopReason,
    stage,
    statusMessage,
    violations: [...violations],
    items: [...items],
    passed
  };
}

function countSkippedRows(items = []) {
  return items.filter((item) => item.status === "skipped").length;
}

function normalizeResumeActionState(value) {
  const normalized = normalizeText(value);
  if (normalized === "已向对方索要") return "索要中";
  return normalized || "UNKNOWN";
}
