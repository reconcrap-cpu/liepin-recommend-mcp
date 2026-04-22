import { sleep } from "../utils.js";
import { recommendSelectors } from "./selectors.js";

const RECOMMEND_RETURN_KEY_EVENT = {
  code: "Escape",
  key: "Escape",
  windowsVirtualKeyCode: 27,
  nativeVirtualKeyCode: 27
};

export async function readRecommendReturnState(client) {
  return client.evaluate((selectors) => {
    const isVisible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || 1) !== 0
        && rect.width > 0
        && rect.height > 0;
    };

    const recommendModalRoot = document.querySelector(selectors.modalRoot);
    const recommendPrintable = document.querySelector(selectors.modalPrintable);
    const drawerBody = document.querySelector(".ant-lpt-drawer-open .ant-lpt-drawer-body");
    const imModalRoots = [
      ...document.querySelectorAll(".ant-im-modal, .ant-im-modal-wrap, .im-ui-chat-modal-container, .im-ui-basic-chat-modal, .im-ui-recommend-chat-modal")
    ].filter(isVisible);
    const cardCount = document.querySelectorAll(selectors.card).length;
    const hasRecommendModal = isVisible(recommendPrintable) || isVisible(recommendModalRoot);
    const hasDrawer = isVisible(drawerBody);
    const hasImModal = imModalRoots.length > 0;
    const blockingKinds = [];
    if (hasImModal) blockingKinds.push("im_modal");
    if (hasRecommendModal) blockingKinds.push("recommend_modal");
    if (hasDrawer) blockingKinds.push("filter_drawer");
    return {
      url: location.href,
      cardCount,
      listReady: cardCount > 0,
      hasRecommendModal,
      hasDrawer,
      hasImModal,
      hasBlockingOverlay: blockingKinds.length > 0,
      blockingKinds
    };
  }, recommendSelectors);
}

export async function closeRecommendModalToList(client, {
  timeoutMs = 10000,
  maxAttempts = 3
} = {}) {
  const before = await readRecommendReturnState(client);
  if (!before.hasRecommendModal && !before.hasBlockingOverlay) {
    return {
      before,
      after: before,
      clickedAny: false,
      clickedKinds: [],
      escapeAttempts: 0,
      closed: false,
      closeMethod: "",
      reason: "recommend_modal_not_open"
    };
  }
  return closeRecommendUiLayers(client, {
    before,
    requireRecommendModalInitially: true,
    timeoutMs,
    maxAttempts
  });
}

export async function clearRecommendBlockingOverlaysToList(client, {
  timeoutMs = 10000,
  maxAttempts = 3
} = {}) {
  const before = await readRecommendReturnState(client);
  if (!before.hasBlockingOverlay) {
    if (String(before.url || "").includes("#preview")) {
      const cleaned = await clearStaleRecommendPreviewRoute(client, {
        timeoutMs
      });
      if (cleaned) {
        return {
          before,
          after: cleaned,
          clickedAny: false,
          clickedKinds: [],
          escapeAttempts: 0,
          closed: true,
          closeMethod: "history_back_cleanup",
          reason: ""
        };
      }
    }
    return {
      before,
      after: before,
      clickedAny: false,
      clickedKinds: [],
      escapeAttempts: 0,
      closed: true,
      closeMethod: "already_list",
      reason: ""
    };
  }
  return closeRecommendUiLayers(client, {
    before,
    requireRecommendModalInitially: false,
    timeoutMs,
    maxAttempts
  });
}

async function clearStaleRecommendPreviewRoute(client, {
  timeoutMs = 1000
} = {}) {
  const currentUrl = await client.evaluate(() => location.href);
  if (!String(currentUrl || "").includes("#preview")) return null;
  await client.evaluate(() => history.back());
  return waitForRecommendListState(client, {
    timeoutMs
  });
}

async function closeRecommendUiLayers(client, {
  before,
  requireRecommendModalInitially,
  timeoutMs,
  maxAttempts
}) {
  const clickedKinds = [];
  let clickedAny = false;
  let escapeAttempts = 0;
  let closeMethod = "";
  const perAttemptTimeoutMs = Math.max(800, Math.floor(timeoutMs / Math.max(1, maxAttempts * 2)));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const clickAttempt = await clickRecommendCloseControls(client);
    if (clickAttempt.clickedAny) {
      clickedAny = true;
      clickedKinds.push(...clickAttempt.clickedKinds);
      if (!closeMethod) closeMethod = "button";
    }

    const closedByClick = await waitForRecommendListState(client, {
      timeoutMs: perAttemptTimeoutMs
    });
    if (closedByClick) {
      return finalizeRecommendClosedResult(client, {
        before,
        after: closedByClick,
        clickedAny,
        clickedKinds: dedupeStrings(clickedKinds),
        escapeAttempts,
        closeMethod,
        timeoutMs: perAttemptTimeoutMs
      });
    }

    const mouseClickAttempt = await clickRecommendCloseControlsByMouse(client);
    if (mouseClickAttempt.clickedAny) {
      clickedAny = true;
      clickedKinds.push(...mouseClickAttempt.clickedKinds);
      if (!closeMethod) closeMethod = "mouse";
      else if (!closeMethod.includes("mouse")) closeMethod = `${closeMethod}+mouse`;
    }

    const closedByMouse = await waitForRecommendListState(client, {
      timeoutMs: perAttemptTimeoutMs
    });
    if (closedByMouse) {
      return finalizeRecommendClosedResult(client, {
        before,
        after: closedByMouse,
        clickedAny,
        clickedKinds: dedupeStrings(clickedKinds),
        escapeAttempts,
        closeMethod,
        timeoutMs: perAttemptTimeoutMs
      });
    }

    await pressEscapeKey(client);
    escapeAttempts += 1;
    if (!closeMethod) closeMethod = "escape";
    else if (!closeMethod.includes("escape")) closeMethod = `${closeMethod}+escape`;

    const closedByEscape = await waitForRecommendListState(client, {
      timeoutMs: perAttemptTimeoutMs
    });
    if (closedByEscape) {
      return finalizeRecommendClosedResult(client, {
        before,
        after: closedByEscape,
        clickedAny,
        clickedKinds: dedupeStrings(clickedKinds),
        escapeAttempts,
        closeMethod,
        timeoutMs: perAttemptTimeoutMs
      });
    }

    const closedByPreviewRouteBack = await closeRecommendPreviewRoute(client, {
      timeoutMs: perAttemptTimeoutMs
    });
    if (closedByPreviewRouteBack) {
      if (!closeMethod) closeMethod = "history_back_modal_close";
      else if (!closeMethod.includes("history_back_modal_close")) {
        closeMethod = `${closeMethod}+history_back_modal_close`;
      }
      return finalizeRecommendClosedResult(client, {
        before,
        after: closedByPreviewRouteBack,
        clickedAny,
        clickedKinds: dedupeStrings(clickedKinds),
        escapeAttempts,
        closeMethod,
        timeoutMs: perAttemptTimeoutMs
      });
    }

    await sleep(150);
  }

  const after = await readRecommendReturnState(client);
  return {
    before,
    after,
    clickedAny,
    clickedKinds: dedupeStrings(clickedKinds),
    escapeAttempts,
    closed: false,
    closeMethod,
    reason: requireRecommendModalInitially && !after.hasRecommendModal && !after.hasBlockingOverlay
      ? "recommend_modal_missing_without_list_restore"
      : "blocking_overlay_not_closed"
  };
}

async function finalizeRecommendClosedResult(client, {
  before,
  after,
  clickedAny,
  clickedKinds,
  escapeAttempts,
  closeMethod,
  timeoutMs
}) {
  let finalAfter = after;
  let finalCloseMethod = closeMethod;
  if (
    String(finalAfter?.url || "").includes("#preview")
    && finalAfter?.hasBlockingOverlay === false
  ) {
    const cleaned = await clearStaleRecommendPreviewRoute(client, {
      timeoutMs
    });
    if (cleaned) {
      finalAfter = cleaned;
      if (!finalCloseMethod) finalCloseMethod = "history_back_cleanup";
      else if (!finalCloseMethod.includes("history_back_cleanup")) {
        finalCloseMethod = `${finalCloseMethod}+history_back_cleanup`;
      }
    }
  }
  return {
    before,
    after: finalAfter,
    clickedAny,
    clickedKinds,
    escapeAttempts,
    closed: true,
    closeMethod: finalCloseMethod
  };
}

async function clickRecommendCloseControls(client) {
  return client.evaluate((selectors) => {
    const isVisible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || 1) !== 0
        && rect.width > 0
        && rect.height > 0;
    };

    const clickedKinds = [];
    const clickNodes = (nodes, kind) => {
      let clicked = false;
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        node.click();
        clicked = true;
      }
      if (clicked) clickedKinds.push(kind);
    };

    clickNodes(
      [...document.querySelectorAll(".ant-im-modal .ant-im-modal-close, .im-ui-recommend-chat-modal .ant-im-modal-close, .im-ui-chat-modal-container .ant-im-modal-close, .im-ui-basic-chat-modal .ant-im-modal-close")],
      "im_modal"
    );
    clickNodes(
      [...document.querySelectorAll(selectors.closeButton)],
      "recommend_modal"
    );
    clickNodes(
      [...document.querySelectorAll(".ant-lpt-drawer-open .ant-lpt-drawer-close")],
      "filter_drawer"
    );

    return {
      clickedAny: clickedKinds.length > 0,
      clickedKinds
    };
  }, recommendSelectors);
}

async function clickRecommendCloseControlsByMouse(client) {
  const targets = await client.evaluate((selectors) => {
    const isVisible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || 1) !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    const toTarget = (node, kind) => {
      const rect = node.getBoundingClientRect();
      return {
        kind,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    };
    const pickVisible = (selector, kind) => {
      const node = [...document.querySelectorAll(selector)].find(isVisible);
      return node ? toTarget(node, kind) : null;
    };
    return [
      pickVisible(".ant-im-modal .ant-im-modal-close, .im-ui-recommend-chat-modal .ant-im-modal-close, .im-ui-chat-modal-container .ant-im-modal-close, .im-ui-basic-chat-modal .ant-im-modal-close", "im_modal"),
      pickVisible(selectors.closeButton, "recommend_modal"),
      pickVisible(".ant-lpt-drawer-open .ant-lpt-drawer-close", "filter_drawer")
    ].filter(Boolean);
  }, recommendSelectors);

  const clickedKinds = [];
  for (const target of targets) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: target.x,
      y: target.y,
      button: "left",
      buttons: 1,
      clickCount: 0
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: target.x,
      y: target.y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: target.x,
      y: target.y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
    clickedKinds.push(target.kind);
  }
  return {
    clickedAny: clickedKinds.length > 0,
    clickedKinds: dedupeStrings(clickedKinds)
  };
}

export async function pressEscapeKey(client) {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...RECOMMEND_RETURN_KEY_EVENT
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...RECOMMEND_RETURN_KEY_EVENT
  });
}

async function waitForRecommendListState(client, {
  timeoutMs = 1000
} = {}) {
  return client.waitFor((selectors) => {
    const isVisible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || 1) !== 0
        && rect.width > 0
        && rect.height > 0;
    };

    const recommendModalRoot = document.querySelector(selectors.modalRoot);
    const recommendPrintable = document.querySelector(selectors.modalPrintable);
    const drawerBody = document.querySelector(".ant-lpt-drawer-open .ant-lpt-drawer-body");
    const imModalRoots = [
      ...document.querySelectorAll(".ant-im-modal, .ant-im-modal-wrap, .im-ui-chat-modal-container, .im-ui-basic-chat-modal, .im-ui-recommend-chat-modal")
    ].filter(isVisible);
    const cardCount = document.querySelectorAll(selectors.card).length;
    const hasRecommendModal = isVisible(recommendPrintable) || isVisible(recommendModalRoot);
    const hasDrawer = isVisible(drawerBody);
    const hasImModal = imModalRoots.length > 0;
    if (hasRecommendModal || hasDrawer || hasImModal || cardCount <= 0) {
      return false;
    }
    return {
      url: location.href,
      cardCount,
      listReady: true,
      hasRecommendModal: false,
      hasDrawer: false,
      hasImModal: false,
      hasBlockingOverlay: false,
      blockingKinds: []
    };
  }, [recommendSelectors], {
    timeoutMs,
    pollMs: 200
  });
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

async function closeRecommendPreviewRoute(client, {
  timeoutMs = 1000
} = {}) {
  const currentUrl = await client.evaluate(() => location.href);
  if (!String(currentUrl || "").includes("#preview")) return null;
  await client.evaluate(() => history.back());
  const closed = await waitForRecommendListState(client, {
    timeoutMs
  });
  if (closed) return closed;

  const after = await readRecommendReturnState(client);
  if (after.hasBlockingOverlay && !String(after.url || "").includes("#preview")) {
    await client.evaluate(() => history.forward());
    await sleep(300);
  }
  return null;
}
