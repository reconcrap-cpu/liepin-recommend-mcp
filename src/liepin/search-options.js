import {
  createPageClient,
  discoverLiepinPages,
  isLiepinRiskPageUrl
} from "../chrome.js";
import { DEFAULT_DEBUG_PORT } from "../constants.js";
import { normalizeText, sleep } from "../utils.js";
import { searchSelectors } from "./selectors.js";

export const SEARCH_OPTIONS_SCHEMA_VERSION = "liepin_search_options_v1";

export async function discoverSearchOptions({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  openJobDropdown = true
} = {}) {
  const pages = await discoverLiepinPages({ port });
  if (!pages.search && pages.riskPage) {
    throw new Error(`检测到猎聘风控/验证码页，已停止搜索页选项发现：${pages.riskPage.url}`);
  }
  if (!pages.search) {
    throw new Error(`未找到猎聘搜索页，请先在 Chrome ${port} 打开 https://lpt.liepin.com/search`);
  }

  const client = await createPageClient(pages.search);
  try {
    await assertNotRiskPage(client, "搜索页选项发现");
    const pageState = await readSearchPageState(client);
    const profiles = await readSearchQuickProfiles(client);
    let jobDropdown = null;
    if (openJobDropdown) {
      await ensureSearchJobSelectorVisible(client);
      jobDropdown = await openSearchSelectedJobDropdown(client);
    }
    return {
      schemaVersion: SEARCH_OPTIONS_SCHEMA_VERSION,
      url: pages.search.url,
      title: pages.search.title,
      pageState,
      profiles,
      jobs: jobDropdown?.jobs || [],
      checkedJobConditions: jobDropdown?.checkedConditions || [],
      jobDropdown,
      passed: profiles.length > 0 && (!openJobDropdown || Boolean(jobDropdown?.opened))
    };
  } finally {
    await client.disconnect();
  }
}

export function summarizeSearchOptions(discovery = {}) {
  return {
    ok: Boolean(discovery.passed),
    profileCount: Array.isArray(discovery.profiles) ? discovery.profiles.length : 0,
    profiles: (discovery.profiles || []).map((profile) => profile.title).filter(Boolean),
    jobCount: Array.isArray(discovery.jobs) ? discovery.jobs.length : 0,
    jobs: (discovery.jobs || []).map((job) => job.title).filter(Boolean),
    checkedJobConditionCount: Array.isArray(discovery.checkedJobConditions)
      ? discovery.checkedJobConditions.length
      : 0
  };
}

export function normalizeSearchOptionTextForMatch(value) {
  const text = normalizeText(value);
  const normalized = typeof text.normalize === "function" ? text.normalize("NFKC") : text;
  return normalized
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/[（]/gu, "(")
    .replace(/[）]/gu, ")")
    .replace(/\s+/gu, "")
    .toLowerCase();
}

export function findSearchOptionMatch(options = [], requestedTitle = "", {
  titleKey = "title"
} = {}) {
  const requested = normalizeText(requestedTitle);
  const requestedLoose = normalizeSearchOptionTextForMatch(requested);
  if (!requested || !requestedLoose) return null;

  const candidates = (Array.isArray(options) ? options : [])
    .map((option, index) => ({
      option,
      index,
      title: normalizeSearchOptionDisplayTitle(option?.[titleKey] ?? option),
      looseTitle: normalizeSearchOptionTextForMatch(option?.[titleKey] ?? option)
    }))
    .filter((candidate) => candidate.title && candidate.looseTitle)
    .map((candidate) => {
      const score = scoreSearchOptionMatch(candidate.title, candidate.looseTitle, requested, requestedLoose);
      return {
        ...candidate,
        score: score.value,
        matchType: score.matchType
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftDistance = Math.abs(left.looseTitle.length - requestedLoose.length);
      const rightDistance = Math.abs(right.looseTitle.length - requestedLoose.length);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return left.index - right.index;
    });

  const best = candidates[0];
  if (!best) return null;
  return {
    ...best.option,
    title: best.title,
    requested,
    matchType: best.matchType,
    index: best.option?.index ?? best.index
  };
}

function normalizeSearchOptionDisplayTitle(value) {
  return normalizeText(value).replace(/[\u200B-\u200D\uFEFF]/gu, "").trim();
}

function scoreSearchOptionMatch(title, looseTitle, requested, requestedLoose) {
  if (title === requested) return { value: 100, matchType: "exact" };
  if (looseTitle === requestedLoose) return { value: 95, matchType: "loose_exact" };
  if (looseTitle.startsWith(requestedLoose) || requestedLoose.startsWith(looseTitle)) {
    return { value: 80, matchType: "loose_prefix" };
  }
  if (looseTitle.includes(requestedLoose) || requestedLoose.includes(looseTitle)) {
    return { value: 70, matchType: "loose_includes" };
  }
  return { value: 0, matchType: "none" };
}

export async function readSearchPageState(client) {
  return client.evaluate((selectors) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const listBox = document.querySelector(selectors.listBox);
    const cards = [...document.querySelectorAll(selectors.cardContent)]
      .concat([...document.querySelectorAll(selectors.cardWrap)].filter((node) => !node.querySelector(".xpath-resume-card")));
    return {
      url: location.href,
      title: document.title,
      hasListBox: Boolean(listBox),
      cardCount: cards.length,
      firstCardHead: getText(cards[0]).slice(0, 160),
      quickSearchHead: getText(document.querySelector(selectors.quickSearchRoot)).slice(0, 160)
    };
  }, searchSelectors);
}

export async function readSearchQuickProfiles(client) {
  const raw = await client.evaluate((selectors) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const findTitleNode = (tag) => [...tag.querySelectorAll("span, div")]
      .find((node) => [...(node.classList || [])].some((className) => className.startsWith("tagTitle--")));
    const root = document.querySelector(selectors.quickSearchRoot) || document;
    return [...root.querySelectorAll(selectors.quickProfileTag)]
      .filter(isVisible)
      .map((tag, index) => {
        const titleNode = findTitleNode(tag);
        const title = getText(titleNode);
        const subscribeText = [...tag.querySelectorAll("button, span, div")]
          .map((node) => getText(node))
          .find((text) => text === "订阅" || text === "退订") || "";
        return {
          index,
          title,
          text: getText(tag),
          subscribeText,
          className: String(tag.className || "")
        };
      })
      .filter((profile) => profile.title);
  }, searchSelectors);
  return normalizeSearchProfiles(raw);
}

export async function ensureSearchJobSelectorVisible(client) {
  const initial = await client.evaluate((selectors) => {
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const wrap = document.querySelector(selectors.selectedJobWrap);
    if (visible(wrap)) {
      return {
        visible: true,
        clickedSearchJobInput: false,
        className: String(wrap.className || "")
      };
    }
    const input = document.querySelector(selectors.searchJobInput);
    if (input) {
      input.scrollIntoView({ block: "center" });
      input.click();
      return {
        visible: false,
        clickedSearchJobInput: true,
        className: String(wrap?.className || "")
      };
    }
    return {
      visible: false,
      clickedSearchJobInput: false,
      reason: "search_job_input_not_found",
      className: String(wrap?.className || "")
    };
  }, searchSelectors);
  if (initial.visible) return initial;
  if (!initial.clickedSearchJobInput) return initial;
  await sleep(700);
  const becameVisible = await client.waitFor((selectors) => {
    const wrap = document.querySelector(selectors.selectedJobWrap);
    if (!wrap) return false;
    const style = window.getComputedStyle(wrap);
    const rect = wrap.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }, [searchSelectors], {
    timeoutMs: 5000,
    pollMs: 200
  });
  return {
    ...initial,
    visible: Boolean(becameVisible)
  };
}

export async function openSearchSelectedJobDropdown(client) {
  await ensureSearchJobSelectorVisible(client);
  const existing = await readSearchJobDropdownState(client);
  if (existing.opened) {
    return {
      ...existing,
      click: {
        clicked: false,
        reason: "already_open"
      }
    };
  }
  const click = await client.evaluate((selectors) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const trigger = document.querySelector(selectors.selectedJobTrigger)
      || document.querySelector(selectors.selectedJobWrap);
    if (!trigger) return { clicked: false, reason: "selected_job_trigger_not_found" };
    trigger.scrollIntoView({ block: "center" });
    trigger.click();
    return {
      clicked: true,
      text: getText(trigger),
      className: String(trigger.className || "")
    };
  }, searchSelectors);
  if (!click.clicked) {
    return {
      opened: false,
      click,
      jobs: [],
      conditions: [],
      checkedConditions: []
    };
  }
  const opened = await client.waitFor((selector) => {
    const dropdown = document.querySelector(selector);
    if (!dropdown) return false;
    const style = window.getComputedStyle(dropdown);
    const rect = dropdown.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }, [searchSelectors.selectedJobDropdownOpen], {
    timeoutMs: 5000,
    pollMs: 200
  });
  const state = await readSearchJobDropdownState(client);
  return {
    ...state,
    opened: Boolean(opened && state.opened),
    click
  };
}

export async function readSearchJobDropdownState(client) {
  return client.evaluate((selectors) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const isVisible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const dropdown = document.querySelector(selectors.selectedJobDropdownOpen)
      || [...document.querySelectorAll(selectors.selectedJobDropdown)].find(isVisible)
      || null;
    if (!dropdown) {
      return {
        opened: false,
        jobs: [],
        conditions: [],
        checkedConditions: []
      };
    }
    const jobs = [...dropdown.querySelectorAll(".jobs-item")]
      .map((node, index) => ({
        index,
        title: getText(node),
        active: /active|selected|current/u.test(String(node.className || "")),
        className: String(node.className || "")
      }))
      .filter((job) => job.title);
    const conditions = [...dropdown.querySelectorAll(".jobs-detail input.ant-lpt-checkbox-input, input.ant-lpt-checkbox-input")]
      .map((input, index) => {
        const wrapper = input.closest("label")
          || input.closest(".ant-lpt-checkbox-wrapper")
          || input.closest("div")
          || input.parentElement;
        return {
          index,
          label: getText(wrapper),
          checked: Boolean(input.checked),
          disabled: Boolean(input.disabled || input.getAttribute("aria-disabled") === "true")
        };
      });
    return {
      opened: true,
      jobs,
      conditions,
      checkedConditions: conditions.filter((condition) => condition.checked)
    };
  }, searchSelectors);
}

export function normalizeSearchProfiles(profiles = []) {
  const seen = new Set();
  const normalized = [];
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const title = normalizeText(profile?.title).replace(/新增$/u, "").trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    normalized.push({
      ...profile,
      title
    });
  }
  return normalized;
}

async function assertNotRiskPage(client, actionLabel) {
  const currentUrl = await client.evaluate(() => location.href);
  if (isLiepinRiskPageUrl(currentUrl)) {
    throw new Error(`检测到猎聘风控/验证码页，已停止${actionLabel}：${currentUrl}`);
  }
}
