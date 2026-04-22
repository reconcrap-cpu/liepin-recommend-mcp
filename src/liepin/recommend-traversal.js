import { createPageClient, discoverLiepinPages, isLiepinRiskPageUrl } from "../chrome.js";
import { DEFAULT_DEBUG_PORT, DEFAULT_RECOMMEND_STEP_DELAY_MS } from "../constants.js";
import { normalizeText, sha1, sleep } from "../utils.js";
import {
  clearRecommendBlockingOverlaysToList,
  closeRecommendModalToList
} from "./recommend-return.js";
import { recommendSelectors } from "./selectors.js";

export const RECOMMEND_TRAVERSAL_SCHEMA_VERSION = "liepin_recommend_traversal_audit_v1";

export async function runRecommendTraversalAudit({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  steps = 10,
  tabLabels = ["推荐", "最新", "推荐"],
  traverseTabLabel = "推荐",
  startIndex = 0,
  stepDelayMs = DEFAULT_RECOMMEND_STEP_DELAY_MS
} = {}) {
  const pages = await discoverLiepinPages({ port });
  if (!pages.recommend && pages.riskPage) {
    throw new Error(`检测到猎聘风控/验证码页，已停止推荐详情遍历：${pages.riskPage.url}`);
  }
  if (!pages.recommend) {
    throw new Error("未找到猎聘推荐页，请先在 Chrome 9222 打开 https://lpt.liepin.com/recommend");
  }

  const client = await createPageClient(pages.recommend);
  try {
    await assertNotRiskPage(client, "推荐详情遍历");
    await ensureRecommendListReady(client);
    await resetRecommendListToTop(client);

    const tabSwitches = [];
    for (const tabLabel of tabLabels) {
      tabSwitches.push(await switchRecommendTabVerified(client, tabLabel));
      await assertNotRiskPage(client, `切换到${tabLabel}后检查`);
    }

    if (tabLabels[tabLabels.length - 1] !== traverseTabLabel) {
      tabSwitches.push(await switchRecommendTabVerified(client, traverseTabLabel));
    }
    await resetRecommendListToTop(client);

    const beforeTraversalList = await readRecommendListState(client);
    const opened = await openRecommendCardByIndex(client, startIndex);
    await sleep(stepDelayMs);
    await assertNotRiskPage(client, "打开推荐详情后检查");

    const items = [];
    const firstSnapshot = await readRecommendModalAuditSnapshot(client, {
      tabLabel: traverseTabLabel,
      step: 0,
      action: "open_card"
    });
    items.push({
      step: 0,
      action: "open_card",
      openAction: opened,
      snapshot: firstSnapshot
    });

    for (let step = 1; step < steps; step += 1) {
      const previous = items[items.length - 1].snapshot;
      const nextAction = await clickRecommendNextAndWait(client, previous.textHash);
      await sleep(stepDelayMs);
      await assertNotRiskPage(client, "推荐详情下一位后检查");
      const snapshot = await readRecommendModalAuditSnapshot(client, {
        tabLabel: traverseTabLabel,
        step,
        action: "next"
      });
      items.push({
        step,
        action: "next",
        nextAction,
        snapshot
      });
      if (!nextAction.changed) break;
    }

    const closeAction = await closeRecommendModalVerified(client);
    const afterTraversalList = await readRecommendListState(client);
    const result = {
      schemaVersion: RECOMMEND_TRAVERSAL_SCHEMA_VERSION,
      requestedSteps: steps,
      traverseTabLabel,
      startIndex,
      stepDelayMs,
      tabSwitches,
      beforeTraversalList,
      items,
      closeAction,
      afterTraversalList,
      riskBlocked: false
    };
    return {
      ...result,
      passed: evaluateRecommendTraversal(result).passed
    };
  } finally {
    await client.disconnect();
  }
}

export function summarizeRecommendTraversal(result) {
  const evaluation = evaluateRecommendTraversal(result);
  return {
    ok: Boolean(result?.passed),
    requestedSteps: result?.requestedSteps || 0,
    traversedSteps: Array.isArray(result?.items) ? result.items.length : 0,
    uniqueSnapshots: countUniqueSnapshots(result?.items || []),
    tabSwitchCount: Array.isArray(result?.tabSwitches) ? result.tabSwitches.length : 0,
    closeVerified: Boolean(result?.closeAction?.closed),
    failures: evaluation.failures
  };
}

export function evaluateRecommendTraversal(result) {
  const failures = [];
  const items = Array.isArray(result?.items) ? result.items : [];
  const tabSwitches = Array.isArray(result?.tabSwitches) ? result.tabSwitches : [];
  const requestedSteps = result?.requestedSteps || 0;

  if (items.length < requestedSteps) failures.push("not_enough_traversal_steps");
  if (countUniqueSnapshots(items) < requestedSteps) failures.push("duplicate_or_stale_modal_snapshots");
  if (!result?.closeAction?.closed) failures.push("modal_not_closed");
  if (tabSwitches.length < 2) failures.push("tab_switch_not_exercised");
  for (const tabSwitch of tabSwitches) {
    if (!tabSwitch.clicked && !tabSwitch.alreadyActive) failures.push(`tab_${tabSwitch.requestedLabel}_not_clicked`);
    if (!tabSwitch.active) failures.push(`tab_${tabSwitch.requestedLabel}_not_active`);
    if (tabSwitch.cardCount <= 0) failures.push(`tab_${tabSwitch.requestedLabel}_no_cards`);
  }
  for (const item of items) {
    const snapshot = item.snapshot || {};
    if (!snapshot.modalOpen) failures.push(`step_${item.step}_modal_not_open`);
    if (!snapshot.textHash) failures.push(`step_${item.step}_missing_hash`);
    if (snapshot.textCharCount < 100) failures.push(`step_${item.step}_text_too_short`);
  }

  return {
    passed: failures.length === 0,
    failures
  };
}

function countUniqueSnapshots(items) {
  return new Set(items.map((item) => item?.snapshot?.textHash).filter(Boolean)).size;
}

async function switchRecommendTabVerified(client, tabLabel) {
  const before = await readRecommendListState(client);
  const clicked = await client.evaluate((selectors, label) => {
    const getText = (node) => (node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
    const labels = [...document.querySelectorAll(selectors.segmentedLabel)];
    const match = labels.find((node) => getText(node) === label);
    if (!match) return { clicked: false, alreadyActive: false, reason: "tab_not_found" };
    const className = String(match.closest(".ant-lpt-segmented-item")?.className || match.className || "");
    const alreadyActive = className.includes("selected");
    if (!alreadyActive) match.click();
    return {
      clicked: !alreadyActive,
      alreadyActive,
      text: getText(match),
      className
    };
  }, recommendSelectors, tabLabel);
  await sleep(1400);
  const ready = await client.waitFor((selector) => document.querySelectorAll(selector).length > 0, [recommendSelectors.card], {
    timeoutMs: 10000,
    pollMs: 250
  });
  if (!ready) throw new Error(`切换推荐 tab 后未看到候选人卡片：${tabLabel}`);
  const after = await readRecommendListState(client);
  const activeLabel = await readActiveRecommendTab(client);
  const listChanged = before.firstCardHead !== after.firstCardHead
    || before.lastCardHead !== after.lastCardHead
    || before.cardCount !== after.cardCount;
  return {
    requestedLabel: tabLabel,
    ...clicked,
    activeLabel,
    active: activeLabel === tabLabel || (clicked.clicked && listChanged && after.cardCount > 0),
    listChanged,
    before,
    after,
    cardCount: after.cardCount
  };
}

async function readActiveRecommendTab(client) {
  return client.evaluate((selector) => {
    const getText = (node) => (node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
    const labels = [...document.querySelectorAll(selector)];
    const selected = labels.find((node) => {
      const item = node.closest(".ant-lpt-segmented-item");
      return String(item?.className || "").includes("selected");
    });
    return getText(selected) || "";
  }, recommendSelectors.segmentedLabel);
}

async function openRecommendCardByIndex(client, index) {
  const clicked = await client.evaluate(({ selector, cardIndex }) => {
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
  if (!clicked.clicked) {
    throw new Error(`未找到可打开的推荐卡片 index=${index} cardCount=${clicked.cardCount}`);
  }
  const ready = await client.waitFor((selector) => {
    const node = document.querySelector(selector);
    return node && (node.textContent || node.innerText || "").trim().length > 100;
  }, [recommendSelectors.modalPrintable], {
    timeoutMs: 10000,
    pollMs: 250
  });
  if (!ready) throw new Error("推荐详情弹窗未出现");
  return clicked;
}

async function clickRecommendNextAndWait(client, previousTextHash) {
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
    const text = (root.textContent || root.innerText || "").trim();
    if (text.length <= 100) return false;
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
    }
    return String(hash) !== expectedHash ? String(hash) : false;
  }, [previousTextHash], {
    timeoutMs: 12000,
    pollMs: 300
  });
  return {
    ...clicked,
    changed: Boolean(changedHash),
    changedHash: changedHash || ""
  };
}

async function readRecommendModalAuditSnapshot(client, {
  tabLabel,
  step,
  action
}) {
  return client.evaluate(({ selectors, currentTabLabel, currentStep, currentAction }) => {
    const modalRoot = document.querySelector(selectors.modalRoot);
    const printable = document.querySelector(selectors.modalPrintable);
    const getText = (node) => (node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
    const hashText = (value) => {
      let hash = 0;
      const text = String(value || "");
      for (let index = 0; index < text.length; index += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
      }
      return String(hash);
    };
    const text = getText(printable);
    return {
      step: currentStep,
      action: currentAction,
      tabLabel: currentTabLabel,
      modalOpen: Boolean(modalRoot && printable),
      candidateLabel: text.slice(0, 80),
      textHash: hashText(text),
      textSha1: "",
      textCharCount: text.length,
      sectionTitles: [...(printable?.querySelectorAll('[class*="header"]') || [])]
        .map((node) => getText(node))
        .filter(Boolean),
      actionLabels: [...(modalRoot?.querySelectorAll("button, a, span") || [])]
        .map((node) => getText(node))
        .filter(Boolean)
        .filter((value, index, list) => list.indexOf(value) === index)
        .slice(0, 20),
      hasNextButton: Boolean(document.querySelector(selectors.nextButton)),
      hasCloseButton: Boolean(document.querySelector(selectors.closeButton)),
      hasOpenChatButton: Boolean(modalRoot?.querySelector(selectors.openChatButton)),
      url: location.href
    };
  }, {
    selectors: recommendSelectors,
    currentTabLabel: tabLabel,
    currentStep: step,
    currentAction: action
  }).then((snapshot) => ({
    ...snapshot,
    textSha1: sha1(`${snapshot.textHash}:${snapshot.textCharCount}:${snapshot.candidateLabel}`)
  }));
}

async function closeRecommendModalVerified(client) {
  return closeRecommendModalToList(client);
}

async function readRecommendListState(client) {
  return client.evaluate((selectors) => {
    const getText = (node) => (node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
    const cards = [...document.querySelectorAll(selectors.card)];
    const keys = cards.map((card) => card.getAttribute("data-tlg-ext")
      || card.getAttribute("data-id")
      || card.getAttribute("data-key")
      || getText(card).slice(0, 120));
    const activeLabel = [...document.querySelectorAll(selectors.segmentedLabel)].find((node) => {
      const item = node.closest(".ant-lpt-segmented-item");
      return String(item?.className || "").includes("selected");
    });
    return {
      url: location.href,
      title: document.title,
      scrollTop: Math.round(window.scrollY || 0),
      scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
      clientHeight: window.innerHeight || document.documentElement.clientHeight,
      cardCount: cards.length,
      uniqueCardCount: new Set(keys).size,
      activeTabLabel: getText(activeLabel),
      firstCardHead: getText(cards[0]).slice(0, 120),
      lastCardHead: getText(cards[cards.length - 1]).slice(0, 120),
      terminalTextVisible: getText(document.body).includes("我也是有底线的")
    };
  }, recommendSelectors);
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

async function assertNotRiskPage(client, actionLabel) {
  const currentUrl = await client.evaluate(() => location.href);
  if (isLiepinRiskPageUrl(currentUrl)) {
    throw new Error(`检测到猎聘风控/验证码页，已停止${actionLabel}：${currentUrl}`);
  }
}
