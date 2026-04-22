import { createPageClient, discoverLiepinPages, isLiepinRiskPageUrl, listTargets } from "../chrome.js";
import { DEFAULT_DEBUG_PORT } from "../constants.js";
import { sleep } from "../utils.js";
import {
  activateAndReadChatRow,
  clickResumeAction,
  readResumeDetailSnapshot,
  returnResumeDetailToChatList,
  setChatSegmentFilter,
  waitForResumeDetailTarget
} from "./chat-sampler.js";
import {
  closeRecommendModal,
  openFirstCandidate,
  readRecommendModalSnapshot,
  switchRecommendTab
} from "./recommend-sampler.js";
import { assertPageRuntimeResponsive } from "./page-health.js";
import { chatSelectors, recommendSelectors, resumeDetailSelectors } from "./selectors.js";
import { normalizeSnapshot } from "./snapshot.js";

export async function probeResumeAcquisitionMatrix({
  port = DEFAULT_DEBUG_PORT
} = {}) {
  return {
    recommend: await probeRecommendAcquisition({ port }),
    chat: await probeChatAcquisition({ port })
  };
}

async function probeRecommendAcquisition({ port }) {
  const pages = await discoverLiepinPages({ port });
  if (!pages.recommend && pages.riskPage) {
    throw new Error(`检测到猎聘风控/验证码页，已停止获取方式探测：${pages.riskPage.url}`);
  }
  if (!pages.recommend) {
    throw new Error("未找到猎聘推荐页，请先在 Chrome 9222 打开 https://lpt.liepin.com/recommend");
  }
  const client = await createPageClient(pages.recommend);
  const requests = [];
  const stopListening = client.on("Network.requestWillBeSent", (params) => {
    const url = String(params?.request?.url || "");
    if (/liepin\.com/i.test(url)) {
      requests.push(url);
    }
  });

  try {
    await client.send("Network.enable");
    await assertNotRiskPage(client);
    await switchRecommendTab(client, "推荐");
    await assertNotRiskPage(client);
    const ready = await client.waitFor((selector) => Boolean(document.querySelector(selector)), [recommendSelectors.card], {
      timeoutMs: 10000,
      pollMs: 250
    });
    if (!ready) throw new Error("推荐页候选人卡片未出现");
    await openFirstCandidate(client);
    await sleep(1200);
    await assertNotRiskPage(client);
    const snapshot = await readRecommendModalSnapshot(client, { tabLabel: "推荐" });
    return {
      route: "recommend_modal",
      tabLabel: "推荐",
      dom: summarizeSnapshot(snapshot),
      network: summarizeRequests(requests)
    };
  } finally {
    stopListening();
    await closeRecommendModal(client).catch(() => {});
    await client.disconnect();
  }
}

async function assertNotRiskPage(client) {
  const currentUrl = await client.evaluate(() => location.href);
  if (isLiepinRiskPageUrl(currentUrl)) {
    throw new Error(`检测到猎聘风控/验证码页，已停止获取方式探测：${currentUrl}`);
  }
}

async function probeChatAcquisition({ port }) {
  const pages = await discoverLiepinPages({ port });
  if (!pages.chat) {
    throw new Error("未找到猎聘聊天页，请先在 Chrome 9222 打开 https://lpt.liepin.com/chat/im");
  }
  const client = await createPageClient(pages.chat);
  const parentRequests = [];
  const stopListening = client.on("Network.requestWillBeSent", (params) => {
    const url = String(params?.request?.url || "");
    if (/liepin\.com/i.test(url)) {
      parentRequests.push(url);
    }
  });

  try {
    await client.send("Network.enable");
    await assertPageRuntimeResponsive(client, { pageName: "猎聘聊天页" });
    await setChatSegmentFilter(client, "有简历");
    const ready = await client.waitFor((selector) => Boolean(document.querySelector(selector)), [chatSelectors.conversationRow], {
      timeoutMs: 10000,
      pollMs: 250
    });
    if (!ready) throw new Error("聊天列表未出现");

    const stateRows = [];
    let availableCandidateState = null;
    let availableFallbackState = null;
    for (let index = 0; index < 20; index += 1) {
      const state = await activateAndReadChatRow(client, index);
      if (!state) break;
      stateRows.push(state);
      if (["看简历", "浏览简历"].includes(state.resumeState)) {
        if (!availableFallbackState) {
          availableFallbackState = state;
        }
        if (!availableCandidateState && state.rowType === "candidate") {
          availableCandidateState = state;
        }
      }
    }

    const stateSummary = summarizeStates(stateRows);
    const availableState = availableCandidateState || availableFallbackState;
    if (!availableState) {
      return {
        route: "chat_resume_detail",
        filterLabel: "有简历",
        stateSummary,
        blocker: "当前聊天页没有可直接打开简历详情的会话（看简历/浏览简历）。",
        network: summarizeRequests(parentRequests)
      };
    }

    const selectedState = await activateAndReadChatRow(client, availableState.rowIndex);
    if (!selectedState || !["看简历", "浏览简历"].includes(selectedState.resumeState)) {
      return {
        route: "chat_resume_detail",
        filterLabel: "有简历",
        selectedRow: availableState,
        stateSummary,
        blocker: "找到可打开简历的会话后，重新激活该会话时简历按钮状态已变化。",
        network: summarizeRequests(parentRequests)
      };
    }

    const knownTargets = await listTargets({ port });
    await clickResumeAction(client, selectedState.resumeState);
    const resumeTarget = await waitForResumeDetailTarget({
      port,
      knownTargets
    });
    if (!resumeTarget) {
      return {
        route: "chat_resume_detail",
        filterLabel: "有简历",
        stateSummary,
        blocker: "点击后未发现新的 resume/detail 页面。",
        network: summarizeRequests(parentRequests)
      };
    }

    const resumeClient = await createPageClient(resumeTarget);
    const childRequests = [];
    const stopChildListening = resumeClient.on("Network.requestWillBeSent", (params) => {
      const url = String(params?.request?.url || "");
      if (/liepin\.com/i.test(url)) {
        childRequests.push(url);
      }
    });
    try {
      await resumeClient.send("Network.enable");
      const printableReady = await resumeClient.waitFor((selector) => Boolean(document.querySelector(selector)), [resumeDetailSelectors.pageWrap], {
        timeoutMs: 10000,
        pollMs: 250
      });
      if (!printableReady) {
        return {
          route: "chat_resume_detail",
          filterLabel: "有简历",
          stateSummary,
          blocker: "resume/detail 页面打开后未出现 printable 内容。",
          network: summarizeRequests([...parentRequests, ...childRequests])
        };
      }
      const snapshot = normalizeSnapshot(await readResumeDetailSnapshot(resumeClient));
      return {
        route: "chat_resume_detail",
        filterLabel: "有简历",
        selectedRow: selectedState,
        stateSummary,
        dom: summarizeSnapshot(snapshot),
        network: summarizeRequests([...parentRequests, ...childRequests])
      };
    } finally {
      stopChildListening();
      await returnResumeDetailToChatList({
        parentClient: client,
        resumeClient,
        resumeTarget,
        knownTargets
      });
    }
  } finally {
    stopListening();
    await client.disconnect();
  }
}

function summarizeSnapshot(snapshot) {
  return {
    captureSource: snapshot.captureSource || snapshot.sourceKind,
    textLength: snapshot.textLength,
    htmlLength: snapshot.htmlLength,
    normalizedSectionIds: snapshot.normalizedSectionIds,
    normalizedActionTokens: snapshot.normalizedActionTokens,
    hasPortfolioWrap: Boolean(snapshot.hasPortfolioWrap),
    hasAttachmentResume: snapshot.normalizedSectionIds.includes("attachment_resume"),
    hasExtraInfo: snapshot.normalizedSectionIds.includes("extra_info"),
    hasOpenImButton: Boolean(snapshot.hasOpenImButton)
  };
}

function summarizeRequests(requests) {
  return [...new Set(requests)]
    .filter((url) => /resume|detail|cvview|chat|collect|attachment|portfolio/i.test(url))
    .slice(0, 30);
}

function summarizeStates(states) {
  const counts = {};
  for (const state of states) {
    counts[state.resumeState] = (counts[state.resumeState] || 0) + 1;
  }
  return {
    totalRows: states.length,
    counts
  };
}
