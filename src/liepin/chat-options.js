import { createPageClient, discoverLiepinPages } from "../chrome.js";
import { DEFAULT_DEBUG_PORT } from "../constants.js";
import { normalizeText, sleep } from "../utils.js";
import { assertPageRuntimeResponsive } from "./page-health.js";
import { chatSelectors } from "./selectors.js";

export const CHAT_OPTIONS_SCHEMA_VERSION = "liepin_chat_options_v1";
export const CHAT_MAX_CONTACTS_SELECTOR = "#main-container > section > section > main > div > div.im-pro-root > div > div.im-ui-pro-content > aside > div:nth-child(3) > div:nth-child(1) > div > div.im-ui-max-contacts";

export async function discoverChatOptions({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  openJobDropdown = true
} = {}) {
  const pages = await discoverLiepinPages({ port });
  if (!pages.chat) {
    throw new Error(`未找到猎聘聊天页，请先在 Chrome ${port} 打开 https://lpt.liepin.com/chat/im`);
  }
  const client = await createPageClient(pages.chat);
  try {
    await assertPageRuntimeResponsive(client, { pageName: "猎聘聊天页" });
    if (openJobDropdown) {
      await openChatJobDropdown(client);
    }
    const current = await readChatJobSelection(client);
    const rawJobs = await readChatJobOptionsFromDom(client);
    const unread = await readChatUnreadState(client);
    if (openJobDropdown) {
      await closeChatJobDropdown(client);
    }
    const jobs = normalizeChatJobOptions(rawJobs);
    return {
      schemaVersion: CHAT_OPTIONS_SCHEMA_VERSION,
      passed: jobs.length > 0 && Boolean(unread.found),
      currentJob: current.currentJob,
      unreadOnly: unread.checked,
      jobs,
      unread,
      rawJobs
    };
  } finally {
    await client.disconnect();
  }
}

export function summarizeChatOptions(discovery = {}) {
  return {
    ok: Boolean(discovery.passed),
    currentJob: discovery.currentJob || "",
    unreadOnly: Boolean(discovery.unreadOnly),
    jobCount: Array.isArray(discovery.jobs) ? discovery.jobs.length : 0,
    jobs: Array.isArray(discovery.jobs)
      ? discovery.jobs.map((job) => job.title).filter(Boolean)
      : []
  };
}

export function normalizeChatJobOptions(rawJobs = []) {
  const options = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawJobs) ? rawJobs : []) {
    const title = normalizeText(raw.title);
    if (!title) continue;
    const description = normalizeText(raw.description);
    const key = `${title}\n${description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({
      title,
      description,
      label: description ? `${title} ${description}` : title,
      selected: Boolean(raw.selected)
    });
  }
  return options;
}

export function chatJobTitleMatches(actualTitle, requestedTitle) {
  const actual = normalizeText(actualTitle);
  const requested = normalizeText(requestedTitle);
  return Boolean(
    actual
    && requested
    && (
      actual === requested
      || actual.startsWith(`${requested} `)
      || actual.startsWith(`${requested} ·`)
    )
  );
}

export async function openChatJobDropdown(client) {
  const clicked = await clickChatElementByMouse(client, chatSelectors.jobFilterSelector);
  if (!clicked.clicked) {
    const fallback = await client.evaluate((selectors) => {
      const node = document.querySelector(selectors.jobFilterSelector)
        || document.querySelector(selectors.jobFilter);
      if (!node) return { clicked: false, reason: "job_filter_not_found" };
      node.click();
      return { clicked: true, method: "dom_click" };
    }, chatSelectors);
    await sleep(600);
    return fallback;
  }
  await sleep(600);
  return clicked;
}

export async function closeChatJobDropdown(client) {
  const open = await client.evaluate((selectors) => {
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    return [...document.querySelectorAll(selectors.jobDropdown)].some(visible);
  }, chatSelectors);
  if (!open) {
    return { closed: false, reason: "dropdown_not_open" };
  }
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  await sleep(250);
  return { closed: true, method: "escape" };
}

export async function readChatJobSelection(client) {
  return client.evaluate((selectors) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const selected = document.querySelector(selectors.jobSelectionItem)
      || document.querySelector(selectors.jobFilterSelector);
    const titleNode = selected?.querySelector?.(".job-title")
      || selected?.querySelector?.(".job-title-span");
    return {
      currentJob: selected?.getAttribute?.("title") || getText(titleNode) || getText(selected)
    };
  }, chatSelectors);
}

export async function readChatJobOptionsFromDom(client) {
  return client.evaluate((selectors) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const optionNodes = [...document.querySelectorAll(selectors.jobOption)];
    return optionNodes.map((node, index) => {
      const titleNode = node.querySelector(".job-title")
        || node.querySelector(".job-title-span")
        || node.querySelector(".ant-im-select-item-option-content");
      const detailNode = node.querySelector(".job-other-info");
      const title = node.getAttribute("title") || getText(titleNode) || getText(node);
      const description = getText(detailNode);
      const className = String(node.className || "");
      return {
        index,
        title,
        description,
        text: getText(node),
        selected: className.includes("ant-im-select-item-option-selected")
          || node.getAttribute("aria-selected") === "true"
      };
    });
  }, chatSelectors);
}

export async function selectChatJob(client, jobTitle) {
  const requestedJob = normalizeText(jobTitle);
  if (!requestedJob) {
    throw new Error("chat_screening 需要 job，请先调用 liepin_chat_options 让用户选择岗位。");
  }
  const before = await readChatJobSelection(client);
  if (chatJobTitleMatches(before.currentJob, requestedJob)) {
    const close = await closeChatJobDropdown(client);
    return {
      ok: true,
      changed: false,
      requestedJob,
      before,
      after: before,
      close
    };
  }

  await openChatJobDropdown(client);
  const availableJobs = normalizeChatJobOptions(await readChatJobOptionsFromDom(client));
  if (!availableJobs.some((job) => job.title === requestedJob)) {
    throw new Error(`聊天页岗位不存在：${requestedJob}；可选岗位：${availableJobs.map((job) => job.title).join("、")}`);
  }

  let click = await clickChatJobOptionByMouse(client, requestedJob);
  if (!click.clicked) {
    click = await clickChatJobOptionByDom(client, requestedJob);
  }
  await sleep(1200);
  const after = await readChatJobSelection(client);
  const ok = chatJobTitleMatches(after.currentJob, requestedJob);
  return {
    ok,
    changed: ok,
    requestedJob,
    before,
    after,
    click,
    availableJobs
  };
}

async function clickChatJobOptionByMouse(client, jobTitle) {
  const target = await client.evaluate((selectors, requestedJob) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || 1) !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    const titleOf = (node) => {
      const titleNode = node.querySelector(".job-title")
        || node.querySelector(".job-title-span")
        || node.querySelector(".ant-im-select-item-option-content");
      return node.getAttribute("title") || getText(titleNode) || getText(node);
    };
    const option = [...document.querySelectorAll(selectors.jobOption)]
      .find((node) => isVisible(node) && titleOf(node) === requestedJob);
    if (!option) return null;
    const rect = option.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }, chatSelectors, jobTitle);
  if (!target) return { clicked: false, reason: "visible_job_option_not_found" };
  await dispatchMouseClick(client, target);
  return { clicked: true, method: "mouse" };
}

async function clickChatJobOptionByDom(client, jobTitle) {
  return client.evaluate((selectors, requestedJob) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const titleOf = (node) => {
      const titleNode = node.querySelector(".job-title")
        || node.querySelector(".job-title-span")
        || node.querySelector(".ant-im-select-item-option-content");
      return node.getAttribute("title") || getText(titleNode) || getText(node);
    };
    const option = [...document.querySelectorAll(selectors.jobOption)]
      .find((node) => titleOf(node) === requestedJob);
    if (!option) return { clicked: false, reason: "job_option_not_found" };
    option.click();
    return { clicked: true, method: "dom_click" };
  }, chatSelectors, jobTitle);
}

export async function readChatUnreadState(client) {
  return client.evaluate((selectors) => {
    const box = document.querySelector(selectors.unreadCheckbox);
    const input = box?.querySelector("input") || box?.closest("label")?.querySelector("input");
    const className = String(box?.className || "");
    const labelText = (box?.closest("label")?.innerText || box?.closest("label")?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    return {
      found: Boolean(box),
      checked: Boolean(input?.checked || className.includes("ant-im-checkbox-checked")),
      checkedByInput: Boolean(input?.checked),
      checkedByClass: className.includes("ant-im-checkbox-checked"),
      className,
      labelText
    };
  }, chatSelectors);
}

export async function ensureChatUnreadFilter(client, unreadOnly) {
  const target = Boolean(unreadOnly);
  const before = await readChatUnreadState(client);
  if (!before.found) {
    throw new Error("未找到聊天页未读 checkbox。");
  }
  if (before.checked === target) {
    return {
      ok: true,
      changed: false,
      target,
      before,
      after: before
    };
  }
  let click = await clickChatElementByMouse(client, chatSelectors.unreadCheckbox);
  if (!click.clicked) {
    click = await client.evaluate((selectors) => {
      const box = document.querySelector(selectors.unreadCheckbox);
      const targetNode = box?.closest("label") || box;
      if (!targetNode) return { clicked: false, reason: "unread_checkbox_not_found" };
      targetNode.click();
      return { clicked: true, method: "dom_click" };
    }, chatSelectors);
  }
  await sleep(1200);
  const after = await readChatUnreadState(client);
  return {
    ok: after.checked === target,
    changed: after.checked === target,
    target,
    before,
    after,
    click
  };
}

export async function clickChatElementByMouse(client, selector, {
  text = null,
  last = false
} = {}) {
  const target = await client.evaluate(({ selector: targetSelector, expectedText, pickLast }) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || 1) !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    const nodes = [...document.querySelectorAll(targetSelector)]
      .filter(isVisible)
      .filter((node) => !expectedText || getText(node) === expectedText);
    const node = pickLast ? nodes.at(-1) : nodes[0];
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: getText(node),
      className: String(node.className || "")
    };
  }, {
    selector,
    expectedText: text,
    pickLast: last
  });
  if (!target) {
    return {
      clicked: false,
      reason: "visible_target_not_found",
      selector
    };
  }
  await dispatchMouseClick(client, target);
  return {
    clicked: true,
    method: "mouse",
    selector,
    target
  };
}

export async function dispatchMouseClick(client, target = {}) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
    button: "none",
    buttons: 0,
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
}

export async function resetChatListToTop(client) {
  return client.evaluate((selectors) => {
    const scroller = findChatListScroller(selectors.conversationRow);
    if (!scroller) return { ok: false, reason: "scroller_not_found" };
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { ok: true, scrollTop: Math.round(scroller.scrollTop) };

    function findChatListScroller(rowSelector) {
      const firstRow = document.querySelector(rowSelector);
      let node = firstRow?.parentElement || null;
      const candidates = [];
      while (node) {
        if (node.scrollHeight > node.clientHeight + 20) candidates.push(node);
        node = node.parentElement;
      }
      return candidates[0] || firstRow?.closest(".im-ui-contacts-wrap") || null;
    }
  }, chatSelectors);
}

export async function scrollChatListByPage(client) {
  return client.evaluate((selectors, maxContactsSelector) => {
    const scroller = findChatListScroller(selectors.conversationRow);
    if (!scroller) return { moved: false, reason: "scroller_not_found" };
    const before = scroller.scrollTop;
    const delta = Math.max(scroller.clientHeight, 500);
    scroller.scrollTop = Math.min(scroller.scrollHeight, before + delta);
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    const maxContacts = document.querySelector(maxContactsSelector);
    const maxContactsVisible = isVisible(maxContacts);
    return {
      moved: Math.abs(scroller.scrollTop - before) > 2,
      before: Math.round(before),
      after: Math.round(scroller.scrollTop),
      scrollHeight: Math.round(scroller.scrollHeight),
      clientHeight: Math.round(scroller.clientHeight),
      atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 3,
      maxContactsVisible,
      maxContactsText: (maxContacts?.innerText || maxContacts?.textContent || "").replace(/\s+/g, " ").trim()
    };

    function findChatListScroller(rowSelector) {
      const firstRow = document.querySelector(rowSelector);
      let node = firstRow?.parentElement || null;
      const candidates = [];
      while (node) {
        if (node.scrollHeight > node.clientHeight + 20) candidates.push(node);
        node = node.parentElement;
      }
      return candidates[0] || firstRow?.closest(".im-ui-contacts-wrap") || null;
    }

    function isVisible(node) {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }
  }, chatSelectors, CHAT_MAX_CONTACTS_SELECTOR);
}

export async function readChatListSnapshot(client) {
  return client.evaluate((selectors, maxContactsSelector) => {
    const rows = [...document.querySelectorAll(selectors.conversationRow)];
    const maxContacts = document.querySelector(maxContactsSelector);
    const scroller = findChatListScroller(selectors.conversationRow);
    const scrollTop = scroller?.scrollTop || 0;
    const clientHeight = scroller?.clientHeight || 0;
    const scrollHeight = scroller?.scrollHeight || 0;
    return {
      rowCount: rows.length,
      scrollTop: Math.round(scrollTop),
      scrollHeight: Math.round(scrollHeight),
      clientHeight: Math.round(clientHeight),
      atBottom: Boolean(scroller && scrollTop + clientHeight >= scrollHeight - 3),
      maxContactsVisible: isVisible(maxContacts),
      maxContactsText: (maxContacts?.innerText || maxContacts?.textContent || "").replace(/\s+/g, " ").trim(),
      rows: rows.map((row, index) => summarizeChatListRow(row, index))
    };

    function summarizeChatListRow(row, index) {
      const rowText = getText(row);
      const rowType = row.classList.contains("im-ui-custom-contact-item") || rowText.startsWith("收到简历")
        ? "system"
        : "candidate";
      const encodedExt = row.getAttribute("data-tlg-ext") || "";
      let contactId = "";
      try {
        contactId = JSON.parse(decodeURIComponent(encodedExt)).to_imid || "";
      } catch {}
      return {
        index,
        rowIndex: index,
        rowKey: contactId || `${rowType}:${rowText.slice(0, 120)}`,
        rowType,
        rowText: rowText.slice(0, 300)
      };
    }

    function getText(node) {
      return (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    }

    function findChatListScroller(rowSelector) {
      const firstRow = document.querySelector(rowSelector);
      let node = firstRow?.parentElement || null;
      const candidates = [];
      while (node) {
        if (node.scrollHeight > node.clientHeight + 20) candidates.push(node);
        node = node.parentElement;
      }
      return candidates[0] || firstRow?.closest(".im-ui-contacts-wrap") || null;
    }

    function isVisible(node) {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }
  }, chatSelectors, CHAT_MAX_CONTACTS_SELECTOR);
}
