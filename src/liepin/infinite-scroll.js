import { createPageClient, discoverLiepinPages, isLiepinRiskPageUrl } from "../chrome.js";
import { DEFAULT_DEBUG_PORT } from "../constants.js";
import { sleep } from "../utils.js";
import { clearRecommendBlockingOverlaysToList } from "./recommend-return.js";
import { assertPageRuntimeResponsive } from "./page-health.js";
import { setChatSegmentFilter } from "./chat-sampler.js";
import { chatSelectors, recommendSelectors } from "./selectors.js";

export const INFINITE_SCROLL_AUDIT_SCHEMA_VERSION = "liepin_infinite_scroll_audit_v1";

export async function auditRecommendInfiniteScroll({
  port = DEFAULT_DEBUG_PORT
} = {}, options = {}) {
  const pages = await discoverLiepinPages({ port });
  if (!pages.recommend && pages.riskPage) {
    throw new Error(`检测到猎聘风控/验证码页，已停止推荐页滚动审计：${pages.riskPage.url}`);
  }
  if (!pages.recommend) {
    throw new Error("未找到猎聘推荐页，请先在 Chrome 9222 打开 https://lpt.liepin.com/recommend");
  }
  const client = await createPageClient(pages.recommend);
  try {
    await assertNotRiskPage(client, "推荐页滚动审计");
    await closeRecommendOverlays(client);
    return await auditInfiniteScroll(client, {
      kind: "recommend",
      itemSelector: recommendSelectors.card,
      scrollContainer: {
        mode: "window"
      },
      resetToTop: true,
      terminalSignalRequired: true,
      bottomSettleDelayMs: 4000,
      terminalSignalGracePasses: 3,
      scrollViewportMultiplier: 4,
      ...options
    });
  } finally {
    await client.disconnect();
  }
}

export async function auditChatInfiniteScroll({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  conversationFilterLabel = "有简历",
  ...options
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
    return await auditInfiniteScroll(client, {
      kind: "chat",
      itemSelector: chatSelectors.conversationRow,
      scrollContainer: {
        mode: "ancestor",
        anchorSelector: chatSelectors.conversationRow
      },
      filterLabel: conversationFilterLabel,
      ...options
    });
  } finally {
    await client.disconnect();
  }
}

export function summarizeInfiniteScrollAudit(result) {
  return {
    ok: Boolean(result?.passed),
    kind: result?.kind || "",
    bottomConfirmed: Boolean(result?.bottomConfirmed),
    terminalSignalRequired: Boolean(result?.terminalSignalRequired),
    terminalSignalConfirmed: Boolean(result?.terminalSignalConfirmed),
    reachedBottom: Boolean(result?.reachedBottom),
    falseBottomDetected: Boolean(result?.falseBottomDetected),
    terminalSignalMissing: Boolean(result?.terminalSignalMissing),
    maxPassesReached: Boolean(result?.maxPassesReached),
    passCount: Array.isArray(result?.passes) ? result.passes.length : 0,
    initialItemCount: result?.initial?.itemCount ?? null,
    finalItemCount: result?.final?.itemCount ?? null,
    uniqueItemCount: result?.final?.uniqueItemCount ?? null
  };
}

export function evaluateBottomAudit({
  final,
  probeChanged,
  maxPassesReached,
  terminalSignalRequired = false
}) {
  const reachedBottom = Boolean(final?.atBottom);
  const terminalSignalConfirmed = Boolean(final?.bottomTextSignals);
  const terminalSignalMissing = reachedBottom && terminalSignalRequired && !terminalSignalConfirmed;
  const falseBottomDetected = reachedBottom && Boolean(probeChanged);
  const bottomConfirmed = reachedBottom
    && !falseBottomDetected
    && !maxPassesReached
    && (!terminalSignalRequired || terminalSignalConfirmed);
  return {
    reachedBottom,
    terminalSignalRequired,
    terminalSignalConfirmed,
    terminalSignalMissing,
    falseBottomDetected,
    bottomConfirmed,
    passed: bottomConfirmed
  };
}

async function auditInfiniteScroll(client, {
  kind,
  itemSelector,
  scrollContainer,
  filterLabel = null,
  maxPasses = 80,
  idlePasses = 3,
  delayMs = 900,
  probeDelayMs = 1200,
  bottomSettleDelayMs = 2500,
  terminalSignalGracePasses = 2,
  terminalSignalRequired = false,
  resetToTop = false,
  scrollViewportMultiplier = 0.85
}) {
  if (resetToTop) {
    await performTopReset(client, { scrollContainer });
    await sleep(500);
  }
  const initial = await readScrollSnapshot(client, { kind, itemSelector, scrollContainer });
  const passes = [];
  let previous = initial;
  let idleCount = 0;
  let bottomIdleCount = 0;
  let maxPassesReached = false;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const wasAtBottom = Boolean(previous.atBottom);
    const scrollAction = wasAtBottom
      ? await performBottomNudge(client, { scrollContainer })
      : await performScrollStep(client, { scrollContainer, scrollViewportMultiplier });
    await sleep(wasAtBottom ? bottomSettleDelayMs : delayMs);
    const current = await readScrollSnapshot(client, { kind, itemSelector, scrollContainer });
    const progress = detectScrollProgress(previous, current);
    passes.push({
      pass,
      phase: wasAtBottom ? "bottom_settle" : "scroll",
      scrollAction,
      progress,
      snapshot: current
    });
    if (progress.changed) {
      idleCount = 0;
    } else {
      idleCount += 1;
    }
    previous = current;
    if (current.atBottom && !progress.changed) {
      bottomIdleCount += 1;
    } else if (!current.atBottom || progress.changed) {
      bottomIdleCount = 0;
    }
    const hasEnoughIdleBottom = current.atBottom && bottomIdleCount >= idlePasses;
    const hasTerminalSignal = Boolean(current.bottomTextSignals);
    if (hasEnoughIdleBottom && (!terminalSignalRequired || hasTerminalSignal)) break;
    if (
      hasEnoughIdleBottom
      && terminalSignalRequired
      && !hasTerminalSignal
      && bottomIdleCount >= idlePasses + terminalSignalGracePasses
    ) {
      break;
    }
    if (pass === maxPasses - 1) maxPassesReached = true;
  }

  const beforeProbe = await readScrollSnapshot(client, { kind, itemSelector, scrollContainer });
  const probes = [];
  for (let probe = 0; probe < 2; probe += 1) {
    const up = await performProbeScroll(client, { scrollContainer, direction: "up" });
    await sleep(250);
    const down = await performProbeScroll(client, { scrollContainer, direction: "down" });
    await sleep(probeDelayMs);
    const snapshot = await readScrollSnapshot(client, { kind, itemSelector, scrollContainer });
    probes.push({
      probe,
      up,
      down,
      snapshot,
      progressFromBeforeProbe: detectContentProgress(beforeProbe, snapshot)
    });
  }

  const final = await readScrollSnapshot(client, { kind, itemSelector, scrollContainer });
  const probeChanged = probes.some((probe) => probe.progressFromBeforeProbe.changed);
  const verdict = evaluateBottomAudit({
    final,
    probeChanged,
    maxPassesReached,
    terminalSignalRequired
  });
  return {
    schemaVersion: INFINITE_SCROLL_AUDIT_SCHEMA_VERSION,
    kind,
    filterLabel,
    itemSelector,
    scrollContainer,
    maxPasses,
    idlePasses,
    delayMs,
    probeDelayMs,
    bottomSettleDelayMs,
    terminalSignalGracePasses,
    terminalSignalRequired,
    resetToTop,
    scrollViewportMultiplier,
    initial,
    passes,
    beforeProbe,
    probes,
    final,
    maxPassesReached,
    ...verdict
  };
}

async function readScrollSnapshot(client, { kind, itemSelector, scrollContainer }) {
  return evaluateSnapshotWithRetry(client, ({ pageKind, selector, containerSpec }) => {
    const getText = (node) => (node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
    const hashText = (value) => {
      let hash = 0;
      const text = String(value || "");
      for (let index = 0; index < text.length; index += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
      }
      return String(hash);
    };
    const getContainer = () => {
      if (containerSpec.mode === "window") {
        return {
          node: document.scrollingElement || document.documentElement,
          mode: "window"
        };
      }
      const anchor = document.querySelector(containerSpec.anchorSelector || selector);
      let node = anchor?.parentElement || null;
      const candidates = [];
      while (node) {
        if (node.scrollHeight > node.clientHeight + 20) candidates.push(node);
        node = node.parentElement;
      }
      return {
        node: candidates[0] || document.scrollingElement || document.documentElement,
        mode: "element"
      };
    };
    const { node, mode } = getContainer();
    const items = [...document.querySelectorAll(selector)];
    const itemSummaries = items.map((item, index) => {
      const text = getText(item).slice(0, 500);
      const explicitKey = item.getAttribute("data-tlg-ext")
        || item.getAttribute("data-id")
        || item.getAttribute("data-key")
        || [...item.classList].find((className) => /xpath-resume-item-wrap-/.test(className))
        || "";
      return {
        index,
        key: explicitKey || hashText(text),
        textHash: hashText(text),
        textHead: text.slice(0, 120)
      };
    });
    const uniqueKeys = [...new Set(itemSummaries.map((item) => item.key))];
    const scrollTop = mode === "window" ? window.scrollY : node.scrollTop;
    const clientHeight = mode === "window" ? window.innerHeight : node.clientHeight;
    const scrollHeight = mode === "window"
      ? Math.max(node.scrollHeight, document.body?.scrollHeight || 0)
      : node.scrollHeight;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 3;
    const visibleTail = itemSummaries.slice(-3).map((item) => item.textHead).join(" ");
    const bodyTail = String(document.body?.textContent || "").slice(-5000);
    const terminalPatterns = [
      "没有更多人选",
      "没有更多人才",
      "没有更多候选",
      "没有更多",
      "暂无更多",
      "已加载全部",
      "已经到底",
      "到底啦",
      "到底了",
      "到底",
      "我也是有底线的",
      "没有了"
    ];
    const findTerminalMatches = (text) => {
      const normalized = String(text || "").replace(/\s+/g, " ").trim();
      return terminalPatterns.filter((pattern) => normalized.includes(pattern));
    };
    const bottomTextMatches = findTerminalMatches(`${bodyTail} ${visibleTail}`);
    return {
      pageKind,
      url: location.href,
      title: document.title,
      mode,
      scrollTop: Math.round(scrollTop),
      scrollHeight: Math.round(scrollHeight),
      clientHeight: Math.round(clientHeight),
      atBottom,
      itemCount: items.length,
      uniqueItemCount: uniqueKeys.length,
      firstItem: itemSummaries[0] || null,
      lastItem: itemSummaries[itemSummaries.length - 1] || null,
      itemSignature: hashText(itemSummaries.map((item) => `${item.key}:${item.textHash}`).join("|")),
      bottomTextSignals: bottomTextMatches.length > 0,
      bottomTextMatches
    };
  }, {
    pageKind: kind,
    selector: itemSelector,
    containerSpec: scrollContainer
  });
}

async function evaluateSnapshotWithRetry(client, expressionOrFunction, ...args) {
  try {
    return await client.evaluate(expressionOrFunction, ...args);
  } catch (error) {
    if (!/CDP timeout: Runtime\.evaluate/.test(error?.message || "")) throw error;
    await sleep(1500);
    try {
      return await client.evaluate(expressionOrFunction, ...args);
    } catch (retryError) {
      throw new Error(`${error.message}; retry failed: ${retryError?.message || String(retryError)}`);
    }
  }
}

async function performTopReset(client, { scrollContainer }) {
  return client.evaluate((containerSpec) => {
    const getContainer = () => {
      if (containerSpec.mode === "window") return document.scrollingElement || document.documentElement;
      const anchor = document.querySelector(containerSpec.anchorSelector);
      let node = anchor?.parentElement || null;
      const candidates = [];
      while (node) {
        if (node.scrollHeight > node.clientHeight + 20) candidates.push(node);
        node = node.parentElement;
      }
      return candidates[0] || document.scrollingElement || document.documentElement;
    };
    const node = getContainer();
    if (containerSpec.mode === "window") {
      window.scrollTo(0, 0);
      window.dispatchEvent(new Event("scroll"));
      return { scrollTop: Math.round(window.scrollY || 0) };
    }
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { scrollTop: Math.round(node.scrollTop || 0) };
  }, scrollContainer);
}

async function performScrollStep(client, { scrollContainer, scrollViewportMultiplier = 0.85 }) {
  return client.evaluate(({ containerSpec, viewportMultiplier }) => {
    const getContainer = () => {
      if (containerSpec.mode === "window") return document.scrollingElement || document.documentElement;
      const anchor = document.querySelector(containerSpec.anchorSelector);
      let node = anchor?.parentElement || null;
      const candidates = [];
      while (node) {
        if (node.scrollHeight > node.clientHeight + 20) candidates.push(node);
        node = node.parentElement;
      }
      return candidates[0] || document.scrollingElement || document.documentElement;
    };
    const node = getContainer();
    const isWindow = containerSpec.mode === "window";
    const beforeTop = isWindow ? window.scrollY : node.scrollTop;
    const clientHeight = isWindow ? window.innerHeight : node.clientHeight;
    const multiplier = Number.isFinite(viewportMultiplier) && viewportMultiplier > 0 ? viewportMultiplier : 0.85;
    const delta = Math.max(Math.floor(clientHeight * multiplier), 500);
    if (isWindow) {
      window.scrollBy(0, delta);
    } else {
      node.scrollTop = Math.min(node.scrollHeight, node.scrollTop + delta);
    }
    const afterTop = isWindow ? window.scrollY : node.scrollTop;
    return {
      delta,
      beforeTop: Math.round(beforeTop),
      afterTop: Math.round(afterTop),
      moved: Math.abs(afterTop - beforeTop) > 2
    };
  }, {
    containerSpec: scrollContainer,
    viewportMultiplier: scrollViewportMultiplier
  });
}

async function performBottomNudge(client, { scrollContainer }) {
  return client.evaluate((containerSpec) => {
    const getContainer = () => {
      if (containerSpec.mode === "window") return document.scrollingElement || document.documentElement;
      const anchor = document.querySelector(containerSpec.anchorSelector);
      let node = anchor?.parentElement || null;
      const candidates = [];
      while (node) {
        if (node.scrollHeight > node.clientHeight + 20) candidates.push(node);
        node = node.parentElement;
      }
      return candidates[0] || document.scrollingElement || document.documentElement;
    };
    const node = getContainer();
    const isWindow = containerSpec.mode === "window";
    const beforeTop = isWindow ? window.scrollY : node.scrollTop;
    const scrollHeight = isWindow
      ? Math.max(node.scrollHeight, document.body?.scrollHeight || 0)
      : node.scrollHeight;
    const upTop = Math.max(0, beforeTop - 80);
    if (isWindow) {
      window.scrollTo(0, upTop);
      window.dispatchEvent(new Event("scroll"));
      window.scrollTo(0, scrollHeight);
      window.dispatchEvent(new Event("scroll"));
    } else {
      node.scrollTop = upTop;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
      node.scrollTop = scrollHeight;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
    const afterTop = isWindow ? window.scrollY : node.scrollTop;
    return {
      direction: "bottom_nudge",
      beforeTop: Math.round(beforeTop),
      afterTop: Math.round(afterTop),
      moved: Math.abs(afterTop - beforeTop) > 2,
      scrollHeight: Math.round(scrollHeight)
    };
  }, scrollContainer);
}

async function performProbeScroll(client, { scrollContainer, direction }) {
  return client.evaluate(({ containerSpec, probeDirection }) => {
    const getContainer = () => {
      if (containerSpec.mode === "window") return document.scrollingElement || document.documentElement;
      const anchor = document.querySelector(containerSpec.anchorSelector);
      let node = anchor?.parentElement || null;
      const candidates = [];
      while (node) {
        if (node.scrollHeight > node.clientHeight + 20) candidates.push(node);
        node = node.parentElement;
      }
      return candidates[0] || document.scrollingElement || document.documentElement;
    };
    const node = getContainer();
    const isWindow = containerSpec.mode === "window";
    const beforeTop = isWindow ? window.scrollY : node.scrollTop;
    const delta = probeDirection === "up" ? -500 : 5000;
    if (isWindow) {
      window.scrollBy(0, delta);
    } else {
      node.scrollTop = Math.max(0, Math.min(node.scrollHeight, node.scrollTop + delta));
    }
    const afterTop = isWindow ? window.scrollY : node.scrollTop;
    return {
      direction: probeDirection,
      beforeTop: Math.round(beforeTop),
      afterTop: Math.round(afterTop),
      moved: Math.abs(afterTop - beforeTop) > 2
    };
  }, {
    containerSpec: scrollContainer,
    probeDirection: direction
  });
}

function detectScrollProgress(previous, current) {
  const content = detectContentProgress(previous, current);
  const scrollChanged = Math.abs((current?.scrollTop || 0) - (previous?.scrollTop || 0)) > 2
    || Math.abs((current?.scrollHeight || 0) - (previous?.scrollHeight || 0)) > 2;
  return {
    changed: scrollChanged || content.changed,
    scrollChanged,
    contentChanged: content.changed,
    itemCountChanged: content.itemCountChanged,
    uniqueItemCountChanged: content.uniqueItemCountChanged,
    signatureChanged: content.signatureChanged
  };
}

function detectContentProgress(previous, current) {
  const itemCountChanged = (current?.itemCount || 0) !== (previous?.itemCount || 0);
  const uniqueItemCountChanged = (current?.uniqueItemCount || 0) !== (previous?.uniqueItemCount || 0);
  const signatureChanged = (current?.itemSignature || "") !== (previous?.itemSignature || "");
  return {
    changed: itemCountChanged || uniqueItemCountChanged || signatureChanged,
    itemCountChanged,
    uniqueItemCountChanged,
    signatureChanged
  };
}

async function closeRecommendOverlays(client) {
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
