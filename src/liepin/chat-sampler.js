import { createPageClient, discoverLiepinPages, listTargets, waitForTarget } from "../chrome.js";
import { DEFAULT_CHAT_SAMPLE_LIMIT, DEFAULT_DEBUG_PORT } from "../constants.js";
import { sleep } from "../utils.js";
import { assertPageRuntimeResponsive } from "./page-health.js";
import { normalizeSnapshot } from "./snapshot.js";
import { chatSelectors, resumeDetailSelectors } from "./selectors.js";

export async function collectChatConversationStates({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  rowLimit = 20,
  conversationFilterLabel = null
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
    const states = [];
    for (let index = 0; index < rowLimit; index += 1) {
      const state = await activateAndReadChatRow(client, index);
      if (!state) break;
      states.push(state);
    }
    return states;
  } finally {
    await client.disconnect();
  }
}

export async function sampleChatResumeDetailResumes({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  limit = DEFAULT_CHAT_SAMPLE_LIMIT,
  afterEach = null,
  conversationFilterLabel = null
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

    const samples = [];
    const visitedRows = new Set();
    const seenTextHashes = new Set();
    let index = 0;
    while (samples.length < limit) {
      const state = await activateAndReadChatRow(client, index);
      if (!state) break;
      index += 1;
      if (visitedRows.has(state.rowKey)) continue;
      visitedRows.add(state.rowKey);
      if (state.rowType === "system") continue;
      if (!["看简历", "浏览简历"].includes(state.resumeState)) continue;

      const knownTargets = await listTargets({ port });
      await clickResumeAction(client, state.resumeState);
      const resumeTarget = await waitForResumeDetailTarget({
        port,
        knownTargets
      });
      if (!resumeTarget) continue;

      const resumeClient = await createPageClient(resumeTarget);
      try {
        const printableReady = await resumeClient.waitFor((selector) => Boolean(document.querySelector(selector)), [resumeDetailSelectors.pageWrap], {
          timeoutMs: 10000,
          pollMs: 250
        });
        if (!printableReady) continue;
        const snapshot = normalizeSnapshot(await readResumeDetailSnapshot(resumeClient));
        if (seenTextHashes.has(snapshot.textHash)) continue;
        seenTextHashes.add(snapshot.textHash);
        samples.push(snapshot);
        if (typeof afterEach === "function") {
          await afterEach(snapshot, samples.length);
        }
      } finally {
        await returnResumeDetailToChatList({
          parentClient: client,
          resumeClient,
          resumeTarget,
          knownTargets
        });
      }
    }

    return samples;
  } finally {
    await client.disconnect();
  }
}

export async function setChatSegmentFilter(client, filterLabel) {
  const clicked = await client.evaluate((label) => {
    const getText = (node) => (node?.innerText || "").replace(/\s+/g, " ").trim();
    const segment = [...document.querySelectorAll(".ant-im-segmented-item-label")]
      .find((node) => getText(node) === label);
    if (!segment) return false;
    segment.click();
    return true;
  }, filterLabel);
  if (!clicked) return false;
  await sleep(1200);
  return true;
}

export async function activateAndReadChatRow(client, index) {
  const rowCount = await client.evaluate((selector) => document.querySelectorAll(selector).length, chatSelectors.conversationRow);
  if (index >= rowCount) return null;
  await client.evaluate(({ selector, rowIndex }) => {
    const rows = [...document.querySelectorAll(selector)];
    const row = rows[rowIndex];
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.click();
  }, {
    selector: chatSelectors.conversationRow,
    rowIndex: index
  });
  await sleep(700);
  const state = await client.evaluate((selectors) => {
    const rows = [...document.querySelectorAll(selectors.conversationRow)];
    const clickedRow = rows[selectors.index] || null;
    const activeRow = rows.find((node) => node.classList.contains("active")) || null;
    const row = activeRow || clickedRow || rows[0];
    if (!row) return null;
    const getText = (node) => (node?.innerText || "").replace(/\s+/g, " ").trim();
    const getTitleOrText = (node) => (node?.getAttribute("title") || getText(node)).replace(/\s+/g, " ").trim();
    const rowText = getText(row);
    const candidateName = getTitleOrText(row.querySelector(selectors.conversationTitleMain));
    const candidateTitle = getTitleOrText(row.querySelector(selectors.conversationTitleSub));
    const resolvedIndex = rows.indexOf(row);
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
      rowIndex: resolvedIndex >= 0 ? resolvedIndex : selectors.index,
      rowKey: contactId || `${rowType}:${rowText.slice(0, 120)}`,
      rowType,
      rowText,
      candidateName,
      candidateTitle,
      resumeState: resumeButton ? getText(resumeButton) : (exactStateText || "UNKNOWN"),
      actionLabels: [...document.querySelectorAll(selectors.genericActionButton)]
        .map((node) => getText(node))
        .filter(Boolean)
    };
  }, {
    ...chatSelectors,
    index
  });
  if (!state) return null;
  return {
    ...state,
    resumeState: normalizeResumeState(state.resumeState)
  };
}

export async function readResumeDetailSnapshot(client) {
  return client.evaluate((selectors) => {
    const getText = (node) => (node?.innerText || "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const roots = [
      ...document.querySelectorAll(selectors.pageWrap),
      ...document.querySelectorAll(selectors.printable)
    ].filter(visible);
    const root = roots
      .map((node) => ({
        node,
        textLength: getText(node).length,
        htmlLength: node.innerHTML.length
      }))
      .sort((a, b) => b.textLength - a.textLength || b.htmlLength - a.htmlLength)[0]?.node || null;
    if (!root) throw new Error("Resume detail page is not ready");
    const fullText = root.innerText || "";
    const firstLine = fullText
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find(Boolean) || "";
    return {
      sourceKind: "chat_resume_detail",
      captureSource: "chat_resume_detail",
      candidateLabel: firstLine,
      rootClasses: root.className ? String(root.className).split(/\s+/).filter(Boolean) : [],
      sectionTitles: [...root.querySelectorAll(selectors.sectionHeader)]
        .map((node) => getText(node))
        .filter(Boolean),
      hasPortfolioWrap: Boolean(root.querySelector(selectors.portfolioWrap)),
      hasOpenImButton: Boolean(document.querySelector(selectors.openImButton)),
      hasIndividualInfo: Boolean(root.querySelector(selectors.individualInfo)),
      actionLabels: [...document.querySelectorAll("button, a, span")]
        .map((node) => getText(node))
        .filter(Boolean)
        .filter((value, index, list) => list.indexOf(value) === index)
        .slice(0, 20),
      fullText,
      htmlLength: root.innerHTML.length
    };
  }, resumeDetailSelectors);
}

function normalizeResumeState(value) {
  if (value === "已向对方索要") return "索要中";
  return value;
}

export async function clickResumeAction(client, resumeState) {
  const clicked = await client.evaluate((selectors, expectedText) => {
    const getText = (node) => (node?.innerText || "").replace(/\s+/g, " ").trim();
    const primary = document.querySelector(selectors.resumeActionButton);
    if (primary && (!expectedText || getText(primary) === expectedText)) {
      primary.click();
      return true;
    }
    const fallback = [...document.querySelectorAll(selectors.specialBrowseButton)]
      .find((node) => getText(node) === expectedText);
    if (!fallback) return false;
    fallback.click();
    return true;
  }, chatSelectors, resumeState);
  if (!clicked) {
    throw new Error(`未找到聊天页简历动作按钮：${resumeState}`);
  }
}

export async function waitForResumeDetailTarget({ port, knownTargets }) {
  const knownById = new Map(knownTargets.map((target) => [target.id, target.url]));
  const knownTargetIds = knownTargets.map((target) => target.id);
  const newTarget = await waitForTarget({
    port,
    knownTargetIds,
    match: (target) => target.type === "page" && String(target.url || "").includes("/resume/detail"),
    timeoutMs: 8000,
    pollMs: 250
  });
  if (newTarget) return newTarget;

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const targets = await listTargets({ port });
    const changedExisting = targets.find((target) => (
      target.type === "page"
      && String(target.url || "").includes("/resume/detail")
      && knownById.get(target.id) !== target.url
    ));
    if (changedExisting) return changedExisting;
    const existing = targets.find((target) => target.type === "page" && String(target.url || "").includes("/resume/detail"));
    if (existing) return existing;
    await sleep(250);
  }
  return null;
}

export async function returnResumeDetailToChatList({
  parentClient,
  resumeClient,
  resumeTarget,
  knownTargets = []
} = {}) {
  const wasSpawnedTarget = Boolean(
    resumeTarget?.id
    && !knownTargets.some((target) => target.id === resumeTarget.id)
  );
  try {
    if (wasSpawnedTarget) {
      await resumeClient.closePage().catch(() => {});
    }
  } finally {
    await resumeClient.disconnect().catch(() => {});
  }
  return {
    closedChildPage: wasSpawnedTarget,
    returnedToChat: Boolean(parentClient)
  };
}
