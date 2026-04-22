import { createPageClient, discoverLiepinPages } from "../chrome.js";
import { DEFAULT_DEBUG_PORT } from "../constants.js";
import { normalizeText, sleep } from "../utils.js";
import { pressEscapeKey } from "./recommend-return.js";
import { activateAndReadChatRow, clickResumeAction, setChatSegmentFilter } from "./chat-sampler.js";
import { classifyChatScreeningEligibility } from "./chat-state-policy.js";
import { assertPageRuntimeResponsive } from "./page-health.js";
import { chatSelectors } from "./selectors.js";

export const CHAT_ACTIONS = {
  REQUEST_RESUME: "request_resume",
  NONE: "none"
};

export async function executeChatAction({
  port = DEFAULT_DEBUG_PORT,
  pageTarget = null
} = {}, {
  action,
  rowKey = null,
  rowIndex = null,
  rowLimit = 40,
  conversationFilterLabel = "有简历"
} = {}) {
  if (!Object.values(CHAT_ACTIONS).includes(action)) {
    throw new Error(`Unsupported chat action: ${action || ""}`);
  }

  const chatTarget = pageTarget || (await discoverLiepinPages({ port })).chat;
  if (!chatTarget) {
    throw new Error("未找到猎聘聊天页，请先在 Chrome 9222 打开 https://lpt.liepin.com/chat/im");
  }
  const client = await createPageClient(chatTarget);
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

    const before = await findTargetScreenableRow(client, { rowKey, rowIndex, rowLimit });
    if (!before) {
      return {
        action,
        executed: false,
        clicked: false,
        before: null,
        after: null,
        ok: false,
        status: "no_screenable_candidate_found"
      };
    }
    const eligibility = classifyChatScreeningEligibility(before);
    if (!eligibility.shouldCallLlm) {
      return {
        action,
        executed: false,
        clicked: false,
        before,
        after: before,
        ok: false,
        status: "target_not_screenable",
        eligibility
      };
    }

    if (action === CHAT_ACTIONS.NONE) {
      return {
        action,
        executed: true,
        clicked: false,
        before,
        after: before,
        ok: true,
        status: "none_noop"
      };
    }

    await clickResumeAction(client, "索要简历");
    const confirmation = await confirmResumeRequestIfPresent(client);
    const after = await waitForResumeRequestState(client, before, rowLimit);
    const sameCandidate = after?.rowKey === before.rowKey;
    const transitioned = sameCandidate && after.resumeState !== "索要简历";
    const cleanup = await cleanupStaleResumeRequestConfirmation(client);
    return {
      action,
      executed: true,
      clicked: true,
      confirmation,
      cleanup,
      before,
      after,
      ok: Boolean(transitioned),
      status: transitioned
        ? "request_resume_clicked"
        : (sameCandidate ? "request_resume_state_not_changed" : "request_resume_candidate_not_found_after_click")
    };
  } finally {
    await client.disconnect();
  }
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

    const title = [...document.querySelectorAll('.ant-im-modal-confirm-title, [class*="modal-confirm-title"]')]
      .find((node) => visible(node) && /确定向对方索要简历吗/.test(getText(node)));
    let modalRoot = title || null;
    while (modalRoot && !modalRoot.classList?.contains("ant-im-modal") && modalRoot.getAttribute("role") !== "dialog") {
      modalRoot = modalRoot.parentElement;
    }
    if (!modalRoot) {
      modalRoot = [...document.querySelectorAll('.ant-im-modal, [role="dialog"]')]
        .find((node) => visible(node) && /确定向对方索要简历吗/.test(getText(node)));
    }
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
      clickedTag: confirmButton.tagName,
      clickedClass: String(confirmButton.className || ""),
      clickedBy: "dom_button_click"
    };
  });
  if (modal?.clicked) {
    const closed = await client.waitFor(() => {
      const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
      const visible = (node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      return ![...document.querySelectorAll('.ant-im-modal, [role="dialog"]')]
        .some((node) => visible(node) && /确定向对方索要简历吗/.test(getText(node)));
    }, [], {
      timeoutMs: 3000,
      pollMs: 150
    });
    await sleep(1000);
    return {
      ...modal,
      modalClosed: Boolean(closed)
    };
  }
  return modal || { present: false, clicked: false };
}

async function cleanupStaleResumeRequestConfirmation(client) {
  const hasStaleConfirmation = await hasResumeRequestConfirmation(client);
  if (!hasStaleConfirmation) {
    return {
      reloaded: false,
      closed: false,
      reason: ""
    };
  }
  const closeAttempt = await client.evaluate(() => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const compactText = (node) => getText(node).replace(/\s+/g, "");
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const modalRoot = [...document.querySelectorAll('.ant-im-modal, [role="dialog"]')]
      .find((node) => visible(node) && /确定向对方索要简历吗/u.test(getText(node)));
    if (!modalRoot) return { clicked: false, reason: "confirmation_not_found" };
    const buttons = [...modalRoot.querySelectorAll("button")]
      .filter((node) => visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true");
    const cancelButton = buttons.find((node) => compactText(node) === "取消")
      || buttons.find((node) => compactText(node).includes("取消"));
    if (cancelButton) {
      cancelButton.click();
      return {
        clicked: true,
        closeMethod: "button",
        clickedText: getText(cancelButton)
      };
    }
    const closeButton = modalRoot.querySelector(".ant-im-modal-close");
    if (closeButton && visible(closeButton)) {
      closeButton.click();
      return {
        clicked: true,
        closeMethod: "button",
        clickedText: "close_icon"
      };
    }
    return { clicked: false, reason: "dismiss_button_not_found" };
  });
  let closeMethod = closeAttempt.clicked ? closeAttempt.closeMethod || "button" : "";
  let closed = await waitForResumeRequestConfirmationClosed(client, 2000);
  if (!closed) {
    await pressEscapeKey(client);
    closeMethod = closeMethod ? `${closeMethod}+escape` : "escape";
    closed = await waitForResumeRequestConfirmationClosed(client, 2000);
  }
  return {
    reloaded: false,
    closed: Boolean(closed),
    reason: closed ? "" : "stale_confirmation_modal",
    closeMethod
  };
}

async function hasResumeRequestConfirmation(client) {
  return client.evaluate(() => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    return [...document.querySelectorAll('.ant-im-modal, [role="dialog"]')]
      .some((node) => visible(node) && /确定向对方索要简历吗/.test(getText(node)));
  });
}

async function waitForResumeRequestConfirmationClosed(client, timeoutMs) {
  return client.waitFor(() => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    return ![...document.querySelectorAll('.ant-im-modal, [role="dialog"]')]
      .some((node) => visible(node) && /确定向对方索要简历吗/u.test(getText(node)));
  }, [], {
    timeoutMs,
    pollMs: 150
  });
}

export function summarizeChatActionResult(result) {
  return {
    action: result?.action || "",
    executed: Boolean(result?.executed),
    clicked: Boolean(result?.clicked),
    ok: Boolean(result?.ok),
    status: result?.status || "",
    beforeState: result?.before?.resumeState || null,
    afterState: result?.after?.resumeState || null,
    rowKey: result?.before?.rowKey || result?.after?.rowKey || ""
  };
}

async function findTargetScreenableRow(client, { rowKey, rowIndex, rowLimit }) {
  if (Number.isInteger(rowIndex) && rowIndex >= 0) {
    const state = await activateAndReadChatRow(client, rowIndex);
    if (!rowKey || state?.rowKey === rowKey) return state;
    return null;
  }
  const wantedKey = normalizeText(rowKey);
  for (let index = 0; index < rowLimit; index += 1) {
    const state = await activateAndReadChatRow(client, index);
    if (!state) break;
    if (wantedKey && state.rowKey !== wantedKey) continue;
    if (wantedKey || classifyChatScreeningEligibility(state).shouldCallLlm) {
      return state;
    }
  }
  return null;
}

async function waitForResumeRequestState(client, before, rowLimit) {
  let latest = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(500);
    const active = await readActiveChatRowState(client);
    if (active?.rowKey === before.rowKey) {
      latest = active;
    }
    if (latest && latest.resumeState !== "索要简历") {
      return latest;
    }
  }
  latest = await activateAndReadChatRowByKey(client, before.rowKey, rowLimit);
  if (latest && latest.resumeState !== "索要简历") {
    return latest;
  }
  return latest;
}

async function activateAndReadChatRowByKey(client, rowKey, rowLimit) {
  for (let index = 0; index < rowLimit; index += 1) {
    const state = await activateAndReadChatRow(client, index);
    if (!state) return null;
    if (state.rowKey === rowKey) return state;
  }
  return null;
}

async function readActiveChatRowState(client) {
  const state = await client.evaluate((selectors) => {
    const rows = [...document.querySelectorAll(selectors.conversationRow)];
    const row = rows.find((node) => node.classList.contains("active")) || null;
    if (!row) return null;
    const getText = (node) => (node?.innerText || "").replace(/\s+/g, " ").trim();
    const rowText = getText(row);
    const encodedExt = row.getAttribute("data-tlg-ext") || "";
    let contactId = "";
    try {
      contactId = JSON.parse(decodeURIComponent(encodedExt)).to_imid || "";
    } catch {}
    const resumeButton = document.querySelector(selectors.resumeActionButton);
    const exactStateText = [...document.querySelectorAll(selectors.specialBrowseButton)]
      .map((node) => getText(node))
      .find((text) => ["索要简历", "索要中", "看简历", "浏览简历", "已向对方索要"].includes(text));
    const rowType = row.classList.contains("im-ui-custom-contact-item") || rowText.startsWith("收到简历")
      ? "system"
      : "candidate";
    return {
      rowIndex: rows.indexOf(row),
      rowKey: contactId || `${rowType}:${rowText.slice(0, 120)}`,
      rowType,
      rowText,
      resumeState: resumeButton ? getText(resumeButton) : (exactStateText || "UNKNOWN"),
      actionLabels: [...document.querySelectorAll(selectors.genericActionButton)]
        .map((node) => getText(node))
        .filter(Boolean)
    };
  }, chatSelectors);
  if (!state) return null;
  return {
    ...state,
    resumeState: state.resumeState === "已向对方索要" ? "索要中" : state.resumeState
  };
}
