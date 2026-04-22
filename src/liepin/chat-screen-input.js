import { createPageClient, discoverLiepinPages } from "../chrome.js";
import { DEFAULT_DEBUG_PORT } from "../constants.js";
import { normalizeText, sha1, sleep } from "../utils.js";
import { activateAndReadChatRow, setChatSegmentFilter } from "./chat-sampler.js";
import { assertPageRuntimeResponsive } from "./page-health.js";
import { chatSelectors } from "./selectors.js";

export const CHAT_SCREEN_INPUT_SCHEMA_VERSION = "liepin_chat_screen_input_v1";

export async function collectChatScreenInputs({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  limit = 10,
  rowLimit = 40,
  conversationFilterLabel = "有简历",
  maxScrollPasses = 3
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

    const inputs = [];
    const seenKeys = new Set();
    let observedRows = 0;
    let screenableRows = 0;

    for (let pass = 0; pass < maxScrollPasses && inputs.length < limit; pass += 1) {
      const rowCount = await client.evaluate((selector) => document.querySelectorAll(selector).length, chatSelectors.conversationRow);
      const cappedRowCount = Math.min(rowCount, rowLimit);
      let newInputsThisPass = 0;
      observedRows += cappedRowCount;

      for (let index = 0; index < cappedRowCount && inputs.length < limit; index += 1) {
        const state = await activateAndReadChatRow(client, index);
        if (!state) break;
        if (state.rowType !== "candidate") continue;
        if (state.resumeState !== "索要简历") continue;
        screenableRows += 1;
        if (seenKeys.has(state.rowKey)) continue;
        seenKeys.add(state.rowKey);

        const input = await readActiveChatScreenInput(client, state);
        inputs.push(input);
        newInputsThisPass += 1;
      }

      if (inputs.length >= limit) break;
      const scrolled = await scrollConversationList(client);
      if (!scrolled || newInputsThisPass === 0) break;
      await sleep(900);
    }

    return {
      schemaVersion: CHAT_SCREEN_INPUT_SCHEMA_VERSION,
      filterLabel: conversationFilterLabel,
      requestedLimit: limit,
      observedRows,
      screenableRows,
      uniqueScreenableCandidates: inputs.length,
      inputs
    };
  } finally {
    await client.disconnect();
  }
}

export async function readActiveChatScreenInput(client, rowState) {
  const raw = await client.evaluate((selectors, state) => {
    const getText = (node) => (node?.innerText || "").replace(/\s+/g, " ").trim();
    const one = (selector) => document.querySelector(selector);
    const allTexts = (selector) => [...document.querySelectorAll(selector)]
      .map((node) => getText(node))
      .filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index);
    const sources = [
      ["conversation_row", state.rowText || ""],
      ["chat_header", getText(one(selectors.chatHeader))],
      ["header_basic_info", getText(one(selectors.chatHeaderBasicInfo))],
      ["header_user_info", getText(one(selectors.chatHeaderUserInfo))],
      ["header_resume_summary", getText(one(selectors.chatHeaderResumeContent))],
      ["header_ext_info", getText(one(selectors.chatHeaderExtInfo))],
      ["header_ext_content", allTexts(selectors.chatHeaderExtContent).join("\n")],
      ["message_list", getText(one(selectors.messageList))],
      ["action_bar", getText(one(selectors.actionBar))]
    ].map(([id, text]) => ({
      id,
      text
    })).filter((source) => source.text);

    return {
      row: state,
      location: location.href,
      candidateHeaderText: getText(one(selectors.chatHeaderBasicInfo)),
      userInfoText: getText(one(selectors.chatHeaderUserInfo)),
      resumeSummaryText: getText(one(selectors.chatHeaderResumeContent)),
      messageListText: getText(one(selectors.messageList)),
      actionLabels: allTexts(selectors.genericActionButton),
      hasRequestResumeButton: allTexts(selectors.specialBrowseButton).includes("索要简历"),
      sources
    };
  }, chatSelectors, rowState);
  return buildChatScreenInput(raw);
}

export function buildChatScreenInput(raw) {
  const sourceBlocks = (raw.sources || []).map((source, index) => {
    const text = normalizeText(source.text);
    return {
      ordinal: index,
      id: source.id,
      text,
      charCount: text.length,
      hash: sha1(text)
    };
  });
  const payloadText = sourceBlocks.map((source) => [
    `[source:${source.ordinal}:${source.id}]`,
    source.text
  ].join("\n")).join("\n\n");
  const row = raw.row || {};
  return {
    schemaVersion: CHAT_SCREEN_INPUT_SCHEMA_VERSION,
    source: {
      page: "chat",
      url: raw.location || "",
      screenableState: "索要简历"
    },
    candidate: {
      rowKey: row.rowKey || "",
      rowIndex: row.rowIndex ?? null,
      rowText: normalizeText(row.rowText),
      headerText: normalizeText(raw.candidateHeaderText),
      userInfoText: normalizeText(raw.userInfoText),
      resumeSummaryText: normalizeText(raw.resumeSummaryText)
    },
    state: {
      rowType: row.rowType || "",
      resumeState: row.resumeState || "",
      actionLabels: Array.isArray(row.actionLabels) ? row.actionLabels : [],
      hasRequestResumeButton: Boolean(raw.hasRequestResumeButton)
    },
    sources: sourceBlocks,
    payloadText,
    manifest: {
      payloadHash: sha1(payloadText),
      payloadCharCount: payloadText.length,
      sourceCount: sourceBlocks.length,
      sourceHashes: sourceBlocks.map(({ ordinal, id, charCount, hash }) => ({
        ordinal,
        id,
        charCount,
        hash
      })),
      requiredSourceIds: [
        "conversation_row",
        "chat_header",
        "header_resume_summary",
        "message_list",
        "action_bar"
      ],
      missingRequiredSourceIds: [
        "conversation_row",
        "chat_header",
        "header_resume_summary",
        "message_list",
        "action_bar"
      ].filter((id) => !sourceBlocks.some((source) => source.id === id && source.charCount > 0))
    }
  };
}

async function scrollConversationList(client) {
  return client.evaluate((selector) => {
    const firstRow = document.querySelector(selector);
    if (!firstRow) return false;
    const candidates = [];
    let node = firstRow.parentElement;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 20) {
        candidates.push(node);
      }
      node = node.parentElement;
    }
    const scroller = candidates[0] || firstRow.closest(".im-ui-contacts-wrap");
    if (!scroller) return false;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + Math.max(scroller.clientHeight, 300);
    return scroller.scrollTop !== before;
  }, chatSelectors.conversationRow);
}
