import { normalizeText, sleep } from "../utils.js";

export const COMMUNICATION_QUOTA_EXHAUSTED_STATUS = "communication_quota_exhausted";

export function isChatCardLimitModalText(value) {
  const text = normalizeText(value);
  const compact = text.replace(/\s+/gu, "");
  return compact.includes("购买开聊卡")
    && (
      compact.includes("资源不足")
      || compact.includes("猎币支付")
      || compact.includes("在线聊意向求职者")
      || compact.includes("免费索要联系方式")
    );
}

export async function readChatCardLimitModal(client) {
  const snapshot = await client.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/gu, " ").trim();
    const compact = (value) => normalize(value).replace(/\s+/gu, "");
    const getText = (node) => normalize(node?.innerText || node?.textContent || "");
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const isChatCardLimitText = (value) => {
      const text = compact(value);
      return text.includes("购买开聊卡")
        && (
          text.includes("资源不足")
          || text.includes("猎币支付")
          || text.includes("在线聊意向求职者")
          || text.includes("免费索要联系方式")
        );
    };
    const roots = [...new Set([
      ...document.querySelectorAll(".ant-lpt-modal-content"),
      ...document.querySelectorAll(".ant-lpt-modal"),
      ...document.querySelectorAll("[role='dialog']")
    ])].filter(visible);
    const modal = roots.find((node) => isChatCardLimitText(getText(node))) || null;
    if (!modal) {
      return {
        present: false,
        status: "",
        reason: "chat_card_limit_modal_not_found"
      };
    }
    const modalText = getText(modal);
    const modalCompact = compact(modalText);
    const title = getText(modal.querySelector(".ant-lpt-modal-title, [class*='modal-title']"));
    const buttons = [...modal.querySelectorAll("button")]
      .filter(visible)
      .map((node) => getText(node))
      .filter(Boolean);
    return {
      present: true,
      status: "communication_quota_exhausted",
      reason: "buy_chat_card_modal",
      title,
      hasResourceInsufficientTip: modalCompact.includes("资源不足"),
      hasLiebiPayment: modalCompact.includes("猎币支付") || modalCompact.includes("猎币"),
      buttonTexts: buttons,
      modalText: modalText.slice(0, 1000)
    };
  });
  if (!snapshot?.present || isChatCardLimitModalText(snapshot.modalText)) {
    return snapshot || {
      present: false,
      status: "",
      reason: "chat_card_limit_modal_not_found"
    };
  }
  return {
    present: false,
    status: "",
    reason: "chat_card_limit_modal_not_found"
  };
}

export async function waitForChatCardLimitModal(client, {
  timeoutMs = 8000,
  pollMs = 250
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await readChatCardLimitModal(client);
    if (latest?.present) return latest;
    await sleep(pollMs);
  }
  return latest || {
    present: false,
    status: "",
    reason: "chat_card_limit_modal_not_found"
  };
}
