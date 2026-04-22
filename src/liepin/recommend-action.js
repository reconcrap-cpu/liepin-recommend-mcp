import {
  classifyLiepinPage,
  createPageClient,
  discoverLiepinPages,
  isLiepinRiskPageUrl,
  listTargets
} from "../chrome.js";
import { DEFAULT_DEBUG_PORT, DEFAULT_RECOMMEND_STEP_DELAY_MS } from "../constants.js";
import { normalizeText, sleep } from "../utils.js";
import {
  clearRecommendBlockingOverlaysToList,
  closeRecommendModalToList
} from "./recommend-return.js";
import {
  assertPageRuntimeResponsive,
  isPageRuntimeUnresponsiveError
} from "./page-health.js";
import { readRecommendModalSnapshot } from "./recommend-sampler.js";
import { chatSelectors, recommendSelectors } from "./selectors.js";

export const RECOMMEND_ACTION_SCHEMA_VERSION = "liepin_recommend_action_v1";
export const RECOMMEND_ACTIONS = new Set(["none", "chat"]);

export async function executeRecommendAction({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  action = "none",
  tabLabel = "推荐",
  startIndex = 0,
  stepDelayMs = DEFAULT_RECOMMEND_STEP_DELAY_MS,
  returnToRecommend = true
} = {}) {
  const normalizedAction = normalizeText(action);
  if (!RECOMMEND_ACTIONS.has(normalizedAction)) {
    throw new Error(`Unsupported recommend action: ${normalizedAction || "(empty)"}`);
  }

  const pages = await discoverLiepinPages({ port });
  if (!pages.recommend && pages.riskPage) {
    throw new Error(`检测到猎聘风控/验证码页，已停止推荐动作：${pages.riskPage.url}`);
  }
  if (!pages.recommend) {
    throw new Error("未找到猎聘推荐页，请先在 Chrome 9222 打开 https://lpt.liepin.com/recommend");
  }

  const client = await createPageClient(pages.recommend);
  try {
    await assertNotRiskPage(client, "推荐动作");
    await ensureRecommendListReady(client);
    await switchRecommendTab(client, tabLabel);
    await resetRecommendListToTop(client);
    await waitForRecommendCards(client);

    const beforeList = await readRecommendListState(client);
    const openAction = await openRecommendCardByIndex(client, startIndex);
    await sleep(stepDelayMs);
    await assertNotRiskPage(client, "打开推荐详情后检查");

    const beforeSnapshot = await readRecommendModalSnapshot(client, { tabLabel });
    const candidate = extractRecommendCandidateIdentity(beforeSnapshot);
    const buttonState = await readRecommendChatButtonState(client);
    const result = {
      schemaVersion: RECOMMEND_ACTION_SCHEMA_VERSION,
      action: normalizedAction,
      tabLabel,
      startIndex,
      stepDelayMs,
      returnToRecommend,
      beforeList,
      openAction,
      candidate,
      beforeSnapshot: summarizeSnapshot(beforeSnapshot),
      buttonState,
      actionExecuted: false,
      actionClicks: 0,
      modalStableAfterNone: null,
      chatVerification: null,
      closeAction: null,
      returnToRecommendResult: null,
      violations: []
    };

    if (normalizedAction === "none") {
      await sleep(1200);
      const afterSnapshot = await readRecommendModalSnapshot(client, { tabLabel });
      result.modalStableAfterNone = afterSnapshot.textHash === beforeSnapshot.textHash;
      if (!result.modalStableAfterNone) {
        result.violations.push({
          code: "none_action_changed_modal",
          beforeTextHash: beforeSnapshot.textHash,
          afterTextHash: afterSnapshot.textHash
        });
      }
      result.closeAction = await closeRecommendModalVerified(client);
      if (!result.closeAction.closed) result.violations.push({ code: "modal_not_closed" });
      return {
        ...result,
        ok: evaluateRecommendAction(result).ok
      };
    }

    const knownTargets = await listTargets({ port });
    const clickAction = await clickRecommendChatButton(client);
    result.actionExecuted = clickAction.clicked;
    result.actionClicks = clickAction.clicked ? 1 : 0;
    result.clickAction = clickAction;
    if (!clickAction.clicked) {
      result.violations.push({
        code: "chat_button_not_clicked",
        reason: clickAction.reason || "unknown"
      });
      result.closeAction = await closeRecommendModalVerified(client);
      return {
        ...result,
        ok: false
      };
    }

    result.chatVerification = await waitForRecommendChatEntryVerification({
      port,
      candidate,
      sourceTargetId: pages.recommend.id,
      knownTargetIds: knownTargets.map((target) => target.id)
    });
    if (!result.chatVerification.verified) {
      result.violations.push({
        code: "chat_entry_not_verified",
        chatVerification: result.chatVerification
      });
    }

    if (returnToRecommend) {
      result.returnToRecommendResult = await returnRecommendClientToList(client);
    }

    return {
      ...result,
      ok: evaluateRecommendAction(result).ok
    };
  } finally {
    await client.disconnect();
  }
}

export function summarizeRecommendActionResult(result) {
  return {
    ok: Boolean(result?.ok),
    action: result?.action || "",
    actionExecuted: Boolean(result?.actionExecuted),
    actionClicks: result?.actionClicks || 0,
    candidateName: result?.candidate?.name || "",
    chatVerified: Boolean(result?.chatVerification?.verified),
    chatEntryKind: result?.chatVerification?.entryKind || "",
    candidateNameMatched: Boolean(result?.chatVerification?.candidateNameMatched),
    hasRequestResumeButton: Boolean(result?.chatVerification?.hasRequestResumeButton),
    returnedToRecommend: result?.returnToRecommendResult?.ok ?? null,
    closeVerified: result?.closeAction?.closed ?? null,
    violations: evaluateRecommendAction(result).violations
  };
}

export function evaluateRecommendAction(result) {
  const violations = Array.isArray(result?.violations) ? [...result.violations] : [];
  if (!RECOMMEND_ACTIONS.has(result?.action)) violations.push({ code: "unsupported_action" });
  if (result?.action === "none") {
    if (result.actionExecuted) violations.push({ code: "none_action_executed" });
    if ((result.actionClicks || 0) !== 0) violations.push({ code: "none_action_clicked" });
    if (!result.modalStableAfterNone) violations.push({ code: "none_modal_not_stable" });
    if (!result.closeAction?.closed) violations.push({ code: "modal_not_closed" });
  }
  if (result?.action === "chat") {
    if (!result.actionExecuted) violations.push({ code: "chat_action_not_executed" });
    if ((result.actionClicks || 0) !== 1) violations.push({ code: "chat_click_count_invalid" });
    if (!result.chatVerification?.verified) violations.push({ code: "chat_not_verified" });
    if (result.candidate?.name && !result.chatVerification?.candidateNameMatched) {
      violations.push({ code: "candidate_name_not_matched" });
    }
    if (result.returnToRecommend && !result.returnToRecommendResult?.ok) {
      violations.push({ code: "return_to_recommend_failed" });
    }
  }
  return {
    ok: violations.length === 0,
    violations: dedupeViolations(violations)
  };
}

export function extractRecommendCandidateIdentity(snapshot = {}) {
  const lines = String(snapshot.fullText || "")
    .split(/\r?\n+/u)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const viewImageIndex = lines.findIndex((line) => line === "查看大图");
  const name = viewImageIndex >= 0 ? lines[viewImageIndex + 1] || "" : "";
  const resumeIdMatch = String(snapshot.fullText || "").match(/简历编号\s*:?\s*([A-Za-z0-9]+)/u);
  return {
    name,
    resumeId: resumeIdMatch?.[1] || "",
    label: snapshot.candidateLabel || "",
    textHash: snapshot.textHash || "",
    structureSignature: snapshot.structureSignature || ""
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

export async function readRecommendChatButtonState(client) {
  return client.evaluate((selectors) => {
    const modalRoot = document.querySelector(selectors.modalRoot);
    const button = modalRoot?.querySelector(selectors.openChatButton) || document.querySelector(selectors.openChatButton);
    const getText = (node) => (node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
    return {
      exists: Boolean(button),
      text: getText(button),
      className: String(button?.className || ""),
      disabled: Boolean(button?.disabled || button?.getAttribute?.("aria-disabled") === "true")
    };
  }, recommendSelectors);
}

export async function clickRecommendChatButton(client) {
  return client.evaluate((selectors) => {
    const modalRoot = document.querySelector(selectors.modalRoot);
    const button = modalRoot?.querySelector(selectors.openChatButton) || document.querySelector(selectors.openChatButton);
    if (!button) return { clicked: false, reason: "button_not_found" };
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      return { clicked: false, reason: "button_disabled" };
    }
    const getText = (node) => (node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
    button.scrollIntoView({ block: "center" });
    button.click();
    return {
      clicked: true,
      text: getText(button),
      className: String(button.className || "")
    };
  }, recommendSelectors);
}

export async function waitForRecommendChatEntryVerification({
  port,
  candidate,
  sourceTargetId = null,
  knownTargetIds = [],
  timeoutMs = 20000,
  pollMs = 1000
}) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;
  const known = new Set(Array.isArray(knownTargetIds) ? knownTargetIds : []);
  const skippedUnresponsiveTargetIds = new Set();
  while (Date.now() < deadline) {
    const targets = (await listTargets({ port }))
      .filter((target) => target.type === "page")
      .map((target) => ({
        id: target.id,
        url: target.url,
        title: target.title,
        type: target.type,
        kind: classifyLiepinPage(target.url),
        webSocketDebuggerUrl: target.webSocketDebuggerUrl
      }));
    const riskPage = targets.find((target) => target.kind === "risk") || null;
    const recommendTargets = targets.filter((target) => target.kind === "recommend");
    const chatTargets = targets.filter((target) => target.kind === "chat");
    if (riskPage && recommendTargets.length === 0 && chatTargets.length === 0) {
      return {
        verified: false,
        reason: "risk_page_detected",
        riskPage
      };
    }

    const sourceTarget = sourceTargetId
      ? targets.find((target) => target.id === sourceTargetId) || null
      : null;

    if (sourceTarget?.kind === "recommend") {
      const client = await createPageClient(sourceTarget);
      try {
        lastSnapshot = await readRecommendEmbeddedChatSnapshot(client, candidate);
        if (lastSnapshot.sentGreetingFound && !lastSnapshot.hasChatEntry) {
          await continueFromSentGreetingToBasicChat(client);
          await sleep(1500);
          lastSnapshot = await readRecommendEmbeddedChatSnapshot(client, candidate);
        }
        if (lastSnapshot.verified) {
          return {
            ...lastSnapshot,
            target: sourceTarget
          };
        }
      } finally {
        await client.disconnect();
      }
    }

    const prioritizedChatTargets = [];
    const seenIds = new Set();
    const pushTarget = (target) => {
      if (!target || target.kind !== "chat" || seenIds.has(target.id)) return;
      seenIds.add(target.id);
      prioritizedChatTargets.push(target);
    };
    if (sourceTarget?.kind === "chat") pushTarget(sourceTarget);
    for (const target of chatTargets.filter((item) => !known.has(item.id))) pushTarget(target);
    for (const target of chatTargets.filter((item) => known.has(item.id))) pushTarget(target);

    for (const target of prioritizedChatTargets) {
      if (skippedUnresponsiveTargetIds.has(target.id)) continue;
      const client = await createPageClient(target);
      try {
        await assertPageRuntimeResponsive(client, {
          pageName: "猎聘聊天页",
          timeoutMs: 4000
        });
        await client.waitFor((selectors) => (
          Boolean(document.querySelector(selectors.chatHeader))
          || Boolean(document.querySelector(selectors.chatContainer))
        ), [chatSelectors], {
          timeoutMs: 8000,
          pollMs: 250
        });
        const snapshot = await readChatEntrySnapshot(client, candidate);
        if (isBetterChatSnapshot(snapshot, lastSnapshot)) {
          lastSnapshot = snapshot;
        }
        if (snapshot.verified) {
          return {
            ...snapshot,
            target
          };
        }
      } catch (error) {
        if (!isPageRuntimeUnresponsiveError(error)) throw error;
        skippedUnresponsiveTargetIds.add(target.id);
        lastSnapshot = {
          ...(lastSnapshot || {}),
          verified: false,
          reason: "chat_target_runtime_unresponsive",
          target,
          error: error.message
        };
      } finally {
        await client.disconnect();
      }
    }
    if (
      prioritizedChatTargets.length > 0
      && prioritizedChatTargets.every((target) => skippedUnresponsiveTargetIds.has(target.id))
    ) {
      return {
        ...(lastSnapshot || {}),
        verified: false,
        reason: "chat_target_runtime_unresponsive"
      };
    }
    await sleep(pollMs);
  }
  return {
    ...(lastSnapshot || {}),
    verified: false,
    reason: "timeout_waiting_for_chat",
    candidateName: candidate?.name || "",
    lastSnapshot
  };
}

export async function readRecommendEmbeddedChatSnapshot(client, candidate) {
  return client.evaluate((selectors, expectedName) => {
    const getText = (node) => (node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => Boolean(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
    const basicChat = document.querySelector(".im-ui-basic-chat-modal, .im-ui-chat-modal-container");
    const sentGreetingModal = document.querySelector(".im-ui-recommend-chat-modal");
    const welcomePopover = document.querySelector(".popover-welcome-msg-body, .ant-lpt-popover.popover-welcom-msg");
    const sentGreetingText = [getText(sentGreetingModal), getText(welcomePopover)].filter(Boolean).join(" ");
    const headerName = getText(document.querySelector(".im-ui-basic-chat-header-name"));
    const headerBasicInfo = getText(document.querySelector(".im-ui-basic-chat-header-basic-info-content"));
    const headerUserInfo = getText(document.querySelector(".im-ui-basic-chat-header-user-info"));
    const messageListText = getText(document.querySelector(".im-ui-message-list-wrapper.im-ui-chat-list, .im-ui-msg-list-content"));
    const actionBarText = getText(document.querySelector(".chatwin-action, .im-ui-chat-input, .actions-left"));
    const jumpButtonText = getText(document.querySelector(".im-ui-basic-chat-header-jump-btn"));
    const combinedText = [
      headerName,
      headerBasicInfo,
      headerUserInfo,
      messageListText,
      actionBarText,
      jumpButtonText,
      sentGreetingText
    ].join(" ");
    const candidateNameMatched = expectedName ? combinedText.includes(expectedName) : false;
    const basicChatText = getText(basicChat);
    const basicChatFound = isVisible(basicChat) && basicChatText.length > 0;
    const sentGreetingFound = (
      isVisible(sentGreetingModal)
      || isVisible(welcomePopover)
    ) && /已向|发送消息/u.test(sentGreetingText);
    const hasChatEntry = basicChatFound && (headerBasicInfo.length > 0 || messageListText.length > 0 || actionBarText.length > 0);
    return {
      url: location.href,
      title: document.title,
      entryKind: hasChatEntry ? "recommend_basic_chat_modal" : (sentGreetingFound ? "recommend_sent_greeting_modal" : ""),
      expectedName,
      basicChatFound,
      sentGreetingFound,
      sentGreetingText: sentGreetingText.slice(0, 300),
      headerName,
      headerBasicInfo,
      headerUserInfo,
      messageListText: messageListText.slice(0, 500),
      actionBarText,
      jumpButtonText,
      combinedText,
      hasChatEntry,
      candidateNameMatched,
      hasJumpToChatPage: jumpButtonText.includes("跳转沟通页"),
      hasRequestResumeButton: actionBarText.includes("索要简历"),
      verified: hasChatEntry && (!expectedName || candidateNameMatched)
    };
  }, recommendSelectors, candidate?.name || "");
}

async function continueFromSentGreetingToBasicChat(client) {
  await client.evaluate(() => {
    const close = document.querySelector(".im-ui-recommend-chat-modal .ant-im-modal-close")
      || document.querySelector(".ant-im-modal .ant-im-modal-close");
    if (close) close.click();
  });
  await sleep(800);
  await client.evaluate((selectors) => {
    const button = document.querySelector(selectors.openChatButton);
    if (!button) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  }, recommendSelectors);
}

async function readChatEntrySnapshot(client, candidate) {
  return client.evaluate((selectors, expectedName) => {
    const getText = (node) => (node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
    const header = document.querySelector(selectors.chatHeader);
    const container = document.querySelector(selectors.chatContainer);
    const basicInfo = document.querySelector(selectors.chatHeaderBasicInfo);
    const userInfo = document.querySelector(selectors.chatHeaderUserInfo);
    const resumeSummary = document.querySelector(selectors.chatHeaderResumeContent);
    const messageList = document.querySelector(selectors.messageList);
    const actionBar = document.querySelector(selectors.actionBar);
    const rows = [...document.querySelectorAll(selectors.conversationRow)];
    const activeRow = rows.find((row) => /active|selected|current/u.test(String(row.className || "")));
    const activeRowText = getText(activeRow);
    const encodedExt = activeRow?.getAttribute("data-tlg-ext") || "";
    let contactId = "";
    try {
      contactId = JSON.parse(decodeURIComponent(encodedExt)).to_imid || "";
    } catch {}
    const actionLabels = [...document.querySelectorAll(selectors.genericActionButton)]
      .map((node) => getText(node))
      .filter(Boolean);
    const resumeButton = document.querySelector(selectors.resumeActionButton);
    const exactStateText = [...document.querySelectorAll(selectors.specialBrowseButton)]
      .map((node) => getText(node))
      .find((text) => ["索要简历", "索要中", "看简历", "浏览简历", "已向对方索要"].includes(text));
    const rowType = activeRow?.classList?.contains("im-ui-custom-contact-item") || activeRowText.startsWith("收到简历")
      ? "system"
      : "candidate";
    const resumeState = resumeButton ? getText(resumeButton) : (exactStateText || "UNKNOWN");
    const normalizedResumeState = resumeState === "已向对方索要" ? "索要中" : resumeState;
    const combinedText = [
      getText(header),
      getText(basicInfo),
      getText(userInfo),
      getText(resumeSummary),
      activeRowText,
      getText(messageList).slice(0, 2000),
      getText(actionBar),
      getText(container).slice(0, 2000)
    ].join(" ");
    const candidateNameMatched = expectedName ? combinedText.includes(expectedName) : false;
    const headerText = getText(header);
    const containerText = getText(container).slice(0, 500);
    const hasChatEntry = Boolean(location.href.includes("chat/im"))
      && (headerText.length > 0 || containerText.length > 0 || activeRowText.length > 0);
    return {
      url: location.href,
      title: document.title,
      expectedName,
      entryKind: "chat_page",
      headerText,
      headerBasicInfo: getText(basicInfo),
      headerUserInfo: getText(userInfo),
      resumeSummaryText: getText(resumeSummary),
      activeRowText,
      messageListText: getText(messageList).slice(0, 500),
      actionBarText: getText(actionBar),
      containerText,
      combinedText,
      hasChatEntry,
      candidateNameMatched,
      hasJumpToChatPage: false,
      hasRequestResumeButton: actionLabels.includes("索要简历") || getText(actionBar).includes("索要简历"),
      activeRowState: {
        rowIndex: rows.indexOf(activeRow),
        rowKey: contactId || `${rowType}:${activeRowText.slice(0, 120)}`,
        rowType,
        rowText: activeRowText,
        resumeState: normalizedResumeState,
        actionLabels
      },
      verified: hasChatEntry && (!expectedName || candidateNameMatched)
    };
  }, chatSelectors, candidate?.name || "");
}

function isBetterChatSnapshot(candidate, current) {
  const score = (snapshot) => {
    if (!snapshot) return -1;
    let value = 0;
    if (snapshot.verified) value += 100;
    if (snapshot.candidateNameMatched) value += 20;
    if (snapshot.hasChatEntry) value += 10;
    if (snapshot.headerText) value += 5;
    if (snapshot.activeRowText) value += 3;
    if (snapshot.containerText) value += 1;
    return value;
  };
  return score(candidate) > score(current);
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

async function returnRecommendClientToList(client) {
  const closeAction = await closeRecommendModalVerified(client);
  return {
    ok: Boolean(closeAction?.closed),
    closeAction
  };
}

async function readRecommendListState(client) {
  return client.evaluate((selectors) => {
    const getText = (node) => (node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
    const cards = [...document.querySelectorAll(selectors.card)];
    return {
      url: location.href,
      cardCount: cards.length,
      firstCardHead: getText(cards[0]).slice(0, 120),
      activeTabLabel: getText([...document.querySelectorAll(selectors.segmentedLabel)].find((node) => {
        const item = node.closest(".ant-lpt-segmented-item");
        return String(item?.className || "").includes("selected");
      }))
    };
  }, recommendSelectors);
}

function summarizeSnapshot(snapshot) {
  return {
    sourceKind: snapshot.sourceKind,
    captureSource: snapshot.captureSource,
    candidateLabel: snapshot.candidateLabel,
    textHash: snapshot.textHash,
    textLength: snapshot.textLength,
    structureSignature: snapshot.structureSignature,
    sectionTitles: snapshot.sectionTitles,
    normalizedActionTokens: snapshot.normalizedActionTokens,
    hasOpenImButton: snapshot.hasOpenImButton
  };
}

function dedupeViolations(violations) {
  const seen = new Set();
  const result = [];
  for (const violation of violations) {
    const code = violation?.code || String(violation);
    if (seen.has(code)) continue;
    seen.add(code);
    result.push(violation);
  }
  return result;
}

async function assertNotRiskPage(client, actionLabel) {
  const currentUrl = await client.evaluate(() => location.href);
  if (isLiepinRiskPageUrl(currentUrl)) {
    throw new Error(`检测到猎聘风控/验证码页，已停止${actionLabel}：${currentUrl}`);
  }
}
