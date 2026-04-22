import { createPageClient, discoverLiepinPages, isLiepinRiskPageUrl } from "../chrome.js";
import {
  DEFAULT_DEBUG_PORT,
  DEFAULT_RECOMMEND_SAMPLE_LIMIT,
  DEFAULT_RECOMMEND_STEP_DELAY_MS
} from "../constants.js";
import { sleep } from "../utils.js";
import { closeRecommendModalToList } from "./recommend-return.js";
import { normalizeSnapshot } from "./snapshot.js";
import { recommendSelectors } from "./selectors.js";

export async function sampleRecommendDetailedResumes({
  port = DEFAULT_DEBUG_PORT,
  tabLabel = "推荐"
} = {}, {
  limit = DEFAULT_RECOMMEND_SAMPLE_LIMIT,
  afterEach = null,
  stepDelayMs = DEFAULT_RECOMMEND_STEP_DELAY_MS
} = {}) {
  const pages = await discoverLiepinPages({ port });
  if (!pages.recommend && pages.riskPage) {
    throw new Error(`检测到猎聘风控/验证码页，已停止推荐页采样以避免继续触发反爬：${pages.riskPage.url}`);
  }
  if (!pages.recommend) {
    throw new Error("未找到猎聘推荐页，请先在 Chrome 9222 打开 https://lpt.liepin.com/recommend");
  }

  const client = await createPageClient(pages.recommend);
  try {
    await assertNotRiskPage(client);
    await switchRecommendTab(client, tabLabel);
    await assertNotRiskPage(client);
    const ready = await client.waitFor((selector) => Boolean(document.querySelector(selector)), [recommendSelectors.card], {
      timeoutMs: 10000,
      pollMs: 250
    });
    if (!ready) {
      throw new Error("推荐页候选人卡片未出现");
    }
    await openFirstCandidate(client);
    await sleep(stepDelayMs);
    await assertNotRiskPage(client);

    const samples = [];
    const seenTextHashes = new Set();
    let stagnantCount = 0;

    while (samples.length < limit && stagnantCount < 5) {
      const snapshot = await readRecommendModalSnapshot(client, { tabLabel });
      if (!seenTextHashes.has(snapshot.textHash)) {
        seenTextHashes.add(snapshot.textHash);
        samples.push(snapshot);
        stagnantCount = 0;
        if (typeof afterEach === "function") {
          await afterEach(snapshot, samples.length);
        }
      } else {
        stagnantCount += 1;
      }

      if (samples.length >= limit) break;
      await sleep(stepDelayMs);
      const advanced = await clickRecommendNext(client, snapshot.domHash);
      await assertNotRiskPage(client);
      await sleep(stepDelayMs);
      if (!advanced) break;
    }

    await closeRecommendModal(client);
    return samples;
  } finally {
    await client.disconnect();
  }
}

export async function switchRecommendTab(client, tabLabel) {
  if (!tabLabel) return;
  const clicked = await client.evaluate((selectors, label) => {
    const labels = [...document.querySelectorAll(selectors.segmentedLabel)];
    const match = labels.find((node) => (node.innerText || "").replace(/\s+/g, " ").trim() === label);
    if (!match) return false;
    match.click();
    return true;
  }, recommendSelectors, tabLabel);
  if (!clicked) return;
  await sleep(1200);
}

export async function openFirstCandidate(client) {
  await client.evaluate((selector) => {
    const first = document.querySelector(selector);
    if (!first) throw new Error("No recommend candidate cards found");
    first.scrollIntoView({ block: "center" });
    first.click();
  }, recommendSelectors.card);
  const ready = await client.waitFor((selector) => {
    const node = document.querySelector(selector);
    return node && (node.innerText || "").trim().length > 100;
  }, [recommendSelectors.modalPrintable], {
    timeoutMs: 10000,
    pollMs: 250
  });
  if (!ready) throw new Error("推荐页详情弹窗未出现");
}

export async function clickRecommendNext(client, currentTextHash) {
  const exists = await client.evaluate((selector) => Boolean(document.querySelector(selector)), recommendSelectors.nextButton);
  if (!exists) return false;
  await client.evaluate((selector) => {
    const button = document.querySelector(selector);
    if (button) button.click();
  }, recommendSelectors.nextButton);
  const changed = await client.waitFor((expectedHash) => {
    const root = document.querySelector('[class*="resume-detail-modal-wrap"] .resume-detail-content-body.printable-content');
    if (!root) return false;
    const text = (root.innerText || "").trim();
    if (text.length <= 100) return false;
    const hash = Array.from(text).reduce((accumulator, char) => ((accumulator << 5) - accumulator + char.charCodeAt(0)) | 0, 0).toString();
    return hash !== expectedHash ? hash : false;
  }, [currentTextHash], {
    timeoutMs: 10000,
    pollMs: 300
  });
  return Boolean(changed);
}

export async function closeRecommendModal(client) {
  return closeRecommendModalToList(client);
}

export async function readRecommendModalSnapshot(client, { tabLabel = "推荐" } = {}) {
  const raw = await client.evaluate((selectors, currentTabLabel) => {
    const modalRoot = document.querySelector(selectors.modalRoot);
    const printable = document.querySelector(selectors.modalPrintable);
    if (!modalRoot || !printable) {
      throw new Error("Recommend modal is not open");
    }
    const getText = (node) => (node?.innerText || "").replace(/\s+/g, " ").trim();
    const fullText = printable.innerText || "";
    const firstLine = fullText
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find(Boolean) || "";
    return {
      sourceKind: "recommend_modal",
      captureSource: `recommend_tab_${currentTabLabel}`,
      recommendTab: currentTabLabel,
      candidateLabel: firstLine,
      rootClasses: printable.className ? String(printable.className).split(/\s+/).filter(Boolean) : [],
      modalClasses: modalRoot.className ? String(modalRoot.className).split(/\s+/).filter(Boolean) : [],
      sectionTitles: [...printable.querySelectorAll('[class*="header"]')]
        .map((node) => getText(node))
        .filter(Boolean),
      hasPortfolioWrap: Boolean(printable.querySelector('[class*="xpath-portfolio-wrap"]')),
      hasOpenImButton: Boolean(modalRoot.querySelector('[class*="xpath-open-im-btn"]')),
      hasIndividualInfo: Boolean(printable.querySelector('[class*="individualInfo"]')),
      actionLabels: [...modalRoot.querySelectorAll("button, a, span")]
        .map((node) => getText(node))
        .filter(Boolean)
        .filter((value, index, list) => list.indexOf(value) === index)
        .slice(0, 20),
      fullText,
      htmlLength: printable.innerHTML.length,
      domHash: Array.from(fullText.trim()).reduce((accumulator, char) => ((accumulator << 5) - accumulator + char.charCodeAt(0)) | 0, 0).toString()
    };
  }, recommendSelectors, tabLabel);
  return normalizeSnapshot(raw);
}

async function assertNotRiskPage(client) {
  const currentUrl = await client.evaluate(() => location.href);
  if (isLiepinRiskPageUrl(currentUrl)) {
    throw new Error(`检测到猎聘风控/验证码页，已停止推荐页采样：${currentUrl}`);
  }
}
