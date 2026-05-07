import { normalizeText, sleep } from "../utils.js";

export const SENT_GREETING_UPSELL_STATUS = "sent_greeting_upsell_modal";

export function isSentGreetingUpsellModalText(value) {
  const text = normalizeText(value);
  const compact = text.replace(/\s+/gu, "");
  return compact.includes("已向候选人发送消息")
    && (
      compact.includes("更快获取人选回复")
      || compact.includes("超级聊聊权益")
      || compact.includes("加急通道触达")
      || compact.includes("免费发起")
    );
}

export async function readSentGreetingUpsellModal(client) {
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
    const isSentGreetingUpsellText = (value) => {
      const text = compact(value);
      return text.includes("已向候选人发送消息")
        && (
          text.includes("更快获取人选回复")
          || text.includes("超级聊聊权益")
          || text.includes("加急通道触达")
          || text.includes("免费发起")
        );
    };
    const roots = [...new Set([
      ...document.querySelectorAll(".ant-im-modal-content"),
      ...document.querySelectorAll(".ant-im-modal"),
      ...document.querySelectorAll(".ant-im-modal-wrap"),
      ...document.querySelectorAll("[role='dialog']")
    ])].filter(visible);
    const modal = roots.find((node) => isSentGreetingUpsellText(getText(node))) || null;
    if (!modal) {
      return {
        present: false,
        status: "",
        reason: "sent_greeting_upsell_modal_not_found"
      };
    }
    const modalText = getText(modal);
    const buttons = [...modal.querySelectorAll("button")]
      .filter(visible)
      .map((node) => getText(node) || node.getAttribute("aria-label") || "")
      .filter(Boolean);
    return {
      present: true,
      status: "sent_greeting_upsell_modal",
      reason: "sent_greeting_upsell_modal",
      title: getText(modal.querySelector(".ant-im-modal-title, [class*='modal-title']")),
      buttonTexts: buttons,
      modalText: modalText.slice(0, 1000)
    };
  });
  if (!snapshot?.present || isSentGreetingUpsellModalText(snapshot.modalText)) {
    return snapshot || {
      present: false,
      status: "",
      reason: "sent_greeting_upsell_modal_not_found"
    };
  }
  return {
    present: false,
    status: "",
    reason: "sent_greeting_upsell_modal_not_found"
  };
}

export async function closeSentGreetingUpsellModal(client, {
  timeoutMs = 3000,
  pollMs = 200
} = {}) {
  const before = await readSentGreetingUpsellModal(client);
  if (!before?.present) {
    return {
      ...before,
      clicked: false,
      closed: true,
      closeMethod: "already_closed"
    };
  }

  const click = await client.evaluate(() => {
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
    const isSentGreetingUpsellText = (value) => {
      const text = compact(value);
      return text.includes("已向候选人发送消息")
        && (
          text.includes("更快获取人选回复")
          || text.includes("超级聊聊权益")
          || text.includes("加急通道触达")
          || text.includes("免费发起")
        );
    };
    const roots = [...new Set([
      ...document.querySelectorAll(".ant-im-modal-content"),
      ...document.querySelectorAll(".ant-im-modal"),
      ...document.querySelectorAll(".ant-im-modal-wrap"),
      ...document.querySelectorAll("[role='dialog']")
    ])].filter(visible);
    const modal = roots.find((node) => isSentGreetingUpsellText(getText(node))) || null;
    if (!modal) return { clicked: false, reason: "sent_greeting_upsell_modal_not_found" };
    const buttons = [...modal.querySelectorAll("button")]
      .filter((node) => visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true");
    const closeByText = buttons.find((node) => getText(node) === "关闭")
      || buttons.find((node) => getText(node).includes("关闭"));
    const closeIcon = modal.querySelector(".ant-im-modal-close")
      || modal.closest(".ant-im-modal")?.querySelector(".ant-im-modal-close")
      || modal.closest(".ant-im-modal-wrap")?.querySelector(".ant-im-modal-close");
    const target = closeByText || closeIcon;
    if (!target) {
      return {
        clicked: false,
        reason: "sent_greeting_upsell_close_not_found",
        buttonTexts: buttons.map((node) => getText(node) || node.getAttribute("aria-label") || "")
      };
    }
    target.click();
    return {
      clicked: true,
      text: getText(target) || target.getAttribute("aria-label") || "",
      className: String(target.className || ""),
      closeMethod: closeByText ? "button_text" : "icon"
    };
  });

  if (!click.clicked) {
    return {
      ...before,
      ...click,
      closed: false
    };
  }

  const closed = await waitForSentGreetingUpsellModalClosed(client, {
    timeoutMs,
    pollMs
  });
  return {
    ...before,
    clicked: true,
    closeClick: click,
    closed: Boolean(closed),
    closeMethod: click.closeMethod
  };
}

async function waitForSentGreetingUpsellModalClosed(client, {
  timeoutMs,
  pollMs
}) {
  const deadline = Date.now() + timeoutMs;
  let latest = await readSentGreetingUpsellModal(client);
  while (Date.now() < deadline) {
    if (!latest?.present) return true;
    await sleep(pollMs);
    latest = await readSentGreetingUpsellModal(client);
  }
  return !latest?.present;
}
