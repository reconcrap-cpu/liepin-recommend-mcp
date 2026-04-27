import { normalizeSnapshot } from "./snapshot.js";
import { searchSelectors } from "./selectors.js";
import { normalizeText, sha1, sleep } from "../utils.js";
import {
  ensureSearchJobSelectorVisible,
  openSearchSelectedJobDropdown,
  readSearchJobDropdownState
} from "./search-options.js";

export const SEARCH_ACTION_SCHEMA_VERSION = "liepin_search_action_v1";

export async function prepareSearchJobSelection(client, {
  jobTitle = null
} = {}) {
  const visible = await ensureSearchJobSelectorVisible(client);
  const dropdown = await openSearchSelectedJobDropdown(client);
  if (!dropdown.opened) {
    throw new Error(`搜索页职位下拉未打开：${dropdown.click?.reason || visible.reason || "unknown"}`);
  }
  let selectedJob = null;
  if (normalizeText(jobTitle)) {
    selectedJob = await selectSearchTopJob(client, jobTitle);
    if (!selectedJob.clicked) {
      throw new Error(`搜索页职位未找到：${jobTitle}；可选职位：${selectedJob.availableJobs?.join("、") || "(empty)"}`);
    }
    await sleep(500);
  }
  const before = await readSearchJobDropdownState(client);
  const clear = await clearSearchJobConditions(client);
  const closed = await client.waitFor((selector) => {
    const dropdown = document.querySelector(selector);
    if (!dropdown) return true;
    const style = window.getComputedStyle(dropdown);
    const rect = dropdown.getBoundingClientRect();
    return style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0;
  }, [searchSelectors.selectedJobDropdownOpen], {
    timeoutMs: 5000,
    pollMs: 200
  });
  return {
    visible,
    dropdown: {
      opened: dropdown.opened,
      jobs: dropdown.jobs,
      checkedConditions: dropdown.checkedConditions
    },
    selectedJob,
    before,
    clear,
    closed: Boolean(closed),
    allUnticked: Boolean(clear.allUnticked)
  };
}

export async function selectSearchTopJob(client, jobTitle) {
  return client.evaluate((selectors, requestedJobTitle) => {
    const normalize = (value) => String(value || "").replace(/[\u200B-\u200D\uFEFF]/gu, "").replace(/\s+/g, " ").trim();
    const getText = (node) => normalize(node?.innerText || node?.textContent || "");
    const dropdown = document.querySelector(selectors.selectedJobDropdownOpen)
      || document.querySelector(selectors.selectedJobDropdown);
    const jobs = [...(dropdown?.querySelectorAll(".jobs-item") || [])]
      .map((node, index) => ({
        index,
        node,
        title: getText(node),
        className: String(node.className || "")
      }))
      .filter((job) => job.title);
    const requested = normalize(requestedJobTitle);
    const match = findBestTextMatch(jobs, requested);
    if (!match) {
      return {
        clicked: false,
        reason: "job_not_found",
        requested,
        availableJobs: jobs.map((job) => job.title)
      };
    }
    match.node.scrollIntoView({ block: "center" });
    match.node.click();
    return {
      clicked: true,
      requested,
      selectedTitle: match.title,
      matchType: match.matchType,
      availableJobs: jobs.map((job) => job.title)
    };

    function findBestTextMatch(items, text) {
      return matchByLooseText(items, text);
    }

    function normalizeLoose(value) {
      const normalized = normalize(value);
      const nfkc = typeof normalized.normalize === "function" ? normalized.normalize("NFKC") : normalized;
      return nfkc
        .replace(/[\u200B-\u200D\uFEFF]/gu, "")
        .replace(/[（]/gu, "(")
        .replace(/[）]/gu, ")")
        .replace(/\s+/gu, "")
        .toLowerCase();
    }

    function matchByLooseText(items, text) {
      const requestedLoose = normalizeLoose(text);
      return items
        .map((item) => {
          const title = normalize(item.title);
          const looseTitle = normalizeLoose(title);
          let score = 0;
          let matchType = "none";
          if (title === text) {
            score = 100;
            matchType = "exact";
          } else if (looseTitle === requestedLoose) {
            score = 95;
            matchType = "loose_exact";
          } else if (looseTitle.startsWith(requestedLoose) || requestedLoose.startsWith(looseTitle)) {
            score = 80;
            matchType = "loose_prefix";
          } else if (looseTitle.includes(requestedLoose) || requestedLoose.includes(looseTitle)) {
            score = 70;
            matchType = "loose_includes";
          } else {
            const tokenScore = tokenCoverageScore(title, text);
            if (tokenScore >= 0.7) {
              score = 60 + Math.round(tokenScore * 10);
              matchType = "token_coverage";
            }
          }
          return {
            ...item,
            title,
            score,
            matchType,
            distance: Math.abs(looseTitle.length - requestedLoose.length)
          };
        })
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.distance - right.distance || left.index - right.index)[0] || null;
    }

    function tokenCoverageScore(candidateText, requestedText) {
      const candidateLoose = normalizeLoose(candidateText);
      const tokens = extractLooseTokens(requestedText);
      if (!tokens.length) return 0;
      const hits = tokens.filter((token) => candidateLoose.includes(token) || candidateLoose.includes(simplifyToken(token)));
      return hits.length / tokens.length;
    }

    function extractLooseTokens(value) {
      return normalize(value)
        .normalize("NFKC")
        .replace(/[（]/gu, "(")
        .replace(/[）]/gu, ")")
        .split(/[·,，;；|、\s]+/u)
        .map((token) => normalizeLoose(token))
        .map(simplifyToken)
        .filter((token) => token.length >= 2);
    }

    function simplifyToken(token) {
      return String(token || "")
        .replace(/及以上$/u, "")
        .replace(/及以下$/u, "");
    }
  }, searchSelectors, jobTitle);
}

export async function clearSearchJobConditions(client) {
  return client.evaluate((selectors) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const dropdown = document.querySelector(selectors.selectedJobDropdownOpen)
      || document.querySelector(selectors.selectedJobDropdown);
    if (!dropdown) {
      return {
        ok: false,
        reason: "dropdown_not_open",
        clickedCount: 0,
        allUnticked: false
      };
    }
    const inputs = [...dropdown.querySelectorAll(".jobs-detail input.ant-lpt-checkbox-input, input.ant-lpt-checkbox-input")];
    const beforeChecked = inputs
      .map((input, index) => ({ index, label: getText(input.closest("label") || input.parentElement), checked: Boolean(input.checked) }))
      .filter((item) => item.checked);
    for (const input of inputs) {
      if (!input.checked || input.disabled || input.getAttribute("aria-disabled") === "true") continue;
      input.click();
    }
    const afterChecked = inputs
      .map((input, index) => ({ index, label: getText(input.closest("label") || input.parentElement), checked: Boolean(input.checked) }))
      .filter((item) => item.checked);
    const buttons = [...dropdown.querySelectorAll("button, [role='button']")];
    const confirm = buttons.find((node) => getText(node) === "确定")
      || buttons.find((node) => getText(node).includes("确定"));
    if (confirm) {
      confirm.scrollIntoView({ block: "center" });
      confirm.click();
    }
    return {
      ok: afterChecked.length === 0,
      beforeChecked,
      afterChecked,
      clickedCount: beforeChecked.length,
      confirmed: Boolean(confirm),
      allUnticked: afterChecked.length === 0
    };
  }, searchSelectors);
}

export async function applySearchQuickProfile(client, {
  profile
} = {}) {
  const requestedProfile = normalizeText(profile);
  if (!requestedProfile) throw new Error("搜索 profile 不能为空");
  const before = await readSearchListState(client);
  const click = await client.evaluate((selectors, requested) => {
    const normalize = (value) => String(value || "").replace(/[\u200B-\u200D\uFEFF]/gu, "").replace(/\s+/g, " ").trim();
    const getText = (node) => normalize(node?.innerText || node?.textContent || "");
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const findTitleNode = (tag) => [...tag.querySelectorAll("span, div")]
      .find((node) => [...(node.classList || [])].some((className) => className.startsWith("tagTitle--")));
    const root = document.querySelector(selectors.quickSearchRoot) || document;
    const profiles = [...root.querySelectorAll(selectors.quickProfileTag)]
      .filter(visible)
      .map((tag, index) => {
        const titleNode = findTitleNode(tag);
        return {
          index,
          tag,
          titleNode,
          title: getText(titleNode),
          text: getText(tag)
        };
      })
      .filter((item) => item.title);
    const target = matchByLooseText(profiles, requested);
    if (!target) {
      return {
        clicked: false,
        reason: "profile_not_found",
        requested,
        availableProfiles: profiles.map((item) => item.title)
      };
    }
    const clickTarget = target.titleNode || target.tag;
    clickTarget.scrollIntoView({ block: "center" });
    clickTarget.click();
    return {
      clicked: true,
      requested,
      selectedProfile: target.title,
      matchType: target.matchType,
      availableProfiles: profiles.map((item) => item.title)
    };

    function normalizeLoose(value) {
      const normalized = normalize(value);
      const nfkc = typeof normalized.normalize === "function" ? normalized.normalize("NFKC") : normalized;
      return nfkc
        .replace(/[\u200B-\u200D\uFEFF]/gu, "")
        .replace(/[（]/gu, "(")
        .replace(/[）]/gu, ")")
        .replace(/\s+/gu, "")
        .toLowerCase();
    }

    function matchByLooseText(items, text) {
      const requestedLoose = normalizeLoose(text);
      return items
        .map((item) => {
          const title = normalize(item.title);
          const looseTitle = normalizeLoose(title);
          let score = 0;
          let matchType = "none";
          if (title === text) {
            score = 100;
            matchType = "exact";
          } else if (looseTitle === requestedLoose) {
            score = 95;
            matchType = "loose_exact";
          } else if (looseTitle.startsWith(requestedLoose) || requestedLoose.startsWith(looseTitle)) {
            score = 80;
            matchType = "loose_prefix";
          } else if (looseTitle.includes(requestedLoose) || requestedLoose.includes(looseTitle)) {
            score = 70;
            matchType = "loose_includes";
          } else {
            const tokenScore = tokenCoverageScore(title, text);
            if (tokenScore >= 0.7) {
              score = 60 + Math.round(tokenScore * 10);
              matchType = "token_coverage";
            }
          }
          return {
            ...item,
            title,
            score,
            matchType,
            distance: Math.abs(looseTitle.length - requestedLoose.length)
          };
        })
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.distance - right.distance || left.index - right.index)[0] || null;
    }

    function tokenCoverageScore(candidateText, requestedText) {
      const candidateLoose = normalizeLoose(candidateText);
      const tokens = extractLooseTokens(requestedText);
      if (!tokens.length) return 0;
      const hits = tokens.filter((token) => candidateLoose.includes(token) || candidateLoose.includes(simplifyToken(token)));
      return hits.length / tokens.length;
    }

    function extractLooseTokens(value) {
      return normalize(value)
        .normalize("NFKC")
        .replace(/[（]/gu, "(")
        .replace(/[）]/gu, ")")
        .split(/[·,，;；|、\s]+/u)
        .map((token) => normalizeLoose(token))
        .map(simplifyToken)
        .filter((token) => token.length >= 2);
    }

    function simplifyToken(token) {
      return String(token || "")
        .replace(/及以上$/u, "")
        .replace(/及以下$/u, "");
    }
  }, searchSelectors, requestedProfile);
  if (!click.clicked) {
    throw new Error(`搜索 profile 未找到：${requestedProfile}；可选 profile：${click.availableProfiles?.join("、") || "(empty)"}`);
  }
  await waitForSearchListRefresh(client, before);
  const after = await readSearchListState(client);
  return {
    profile: requestedProfile,
    click,
    before,
    after,
    verified: Boolean(after.cardCount > 0 || after.firstCardHash !== before.firstCardHash)
  };
}

export async function setSearchHideReadFilter(client, {
  hideRead = false
} = {}) {
  const target = Boolean(hideRead);
  const before = await readSearchHideReadFilterState(client);
  if (!before.found) {
    throw new Error("搜索页未找到“隐藏已查看”checkbox：input[name=\"filterRead\"]");
  }
  const beforeList = await readSearchListState(client);
  const click = before.checked === target
    ? { clicked: false, reason: "already_matches" }
    : await clickSearchHideReadFilter(client);
  const after = await waitForSearchHideReadFilterState(client, target);
  if (!isSearchHideReadStateVerified(after, target)) {
    throw new Error(`搜索页“隐藏已查看”checkbox 状态确认失败：期望 ${target ? "勾选" : "取消勾选"}，实际 ${after.checked ? "勾选" : "取消勾选"}`);
  }
  const afterList = click.clicked
    ? await waitForSearchListRefresh(client, beforeList, { timeoutMs: 8000 })
    : await readSearchListState(client);
  return {
    target,
    before,
    click,
    after,
    afterList,
    verified: true
  };
}

export async function readSearchHideReadFilterState(client) {
  return client.evaluate((selectors) => {
    const input = document.querySelector(selectors.hideReadCheckboxInput);
    const checkbox = input?.closest(".ant-lpt-checkbox") || null;
    const wrapper = input?.closest("label") || checkbox;
    return {
      found: Boolean(input),
      checked: Boolean(input?.checked),
      value: input?.value ?? null,
      className: String(checkbox?.className || ""),
      wrapperText: (wrapper?.innerText || wrapper?.textContent || "").replace(/\s+/g, " ").trim()
    };
  }, searchSelectors);
}

export function isSearchHideReadStateVerified(state = {}, expected = false) {
  if (!state.found) return false;
  const target = Boolean(expected);
  if (Boolean(state.checked) !== target) return false;
  const className = String(state.className || "");
  if (target) {
    return state.value === "1" && className.includes("ant-lpt-checkbox-checked");
  }
  return state.value === "" && !className.includes("ant-lpt-checkbox-checked");
}

async function clickSearchHideReadFilter(client) {
  return client.evaluate((selectors) => {
    const input = document.querySelector(selectors.hideReadCheckboxInput);
    if (!input) {
      return {
        clicked: false,
        reason: "filter_read_not_found"
      };
    }
    input.click();
    const checkbox = input.closest(".ant-lpt-checkbox");
    return {
      clicked: true,
      checked: Boolean(input.checked),
      value: input.value,
      className: String(checkbox?.className || "")
    };
  }, searchSelectors);
}

async function waitForSearchHideReadFilterState(client, target, {
  timeoutMs = 4000,
  pollMs = 200
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = await readSearchHideReadFilterState(client);
  while (Date.now() < deadline) {
    if (isSearchHideReadStateVerified(latest, target)) return latest;
    await sleep(pollMs);
    latest = await readSearchHideReadFilterState(client);
  }
  return latest;
}

export async function waitForSearchListRefresh(client, before = {}, {
  timeoutMs = 12000
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(400);
    const state = await readSearchListState(client);
    if (state.cardCount > 0 && state.firstCardText && state.firstCardHash !== before.firstCardHash) return state;
    if (state.cardCount > 0 && state.firstCardText && !before.firstCardHash) return state;
  }
  return readSearchListState(client);
}

export async function readSearchListState(client) {
  const raw = await client.evaluate((selectors) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const primaryCards = [...document.querySelectorAll(selectors.cardContent)]
      .filter((node) => visible(node) && getText(node).length > 0);
    const fallbackCards = [...document.querySelectorAll(selectors.cardWrap)]
      .filter((node) => visible(node) && !node.querySelector(".xpath-resume-card") && getText(node).length > 0);
    const cards = primaryCards.length > 0 ? primaryCards : fallbackCards;
    const activePage = [...document.querySelectorAll(`${selectors.pagebar} li`)]
      .find((node) => String(node.className || "").includes("active"));
    return {
      url: location.href,
      title: document.title,
      cardCount: cards.length,
      firstCardText: getText(cards[0]).slice(0, 500),
      firstCardHead: getText(cards[0]).slice(0, 160),
      activePageText: getText(activePage),
      listTextLength: getText(document.querySelector(selectors.listBox)).length
    };
  }, searchSelectors);
  return {
    ...raw,
    firstCardHash: raw.firstCardText ? sha1(raw.firstCardText) : ""
  };
}

export async function waitForSearchCards(client, {
  timeoutMs = 12000
} = {}) {
  const ready = await client.waitFor((selectors) => (
    [...document.querySelectorAll(selectors.cardContent)].some((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && text.length > 20;
    })
  ), [searchSelectors], {
    timeoutMs,
    pollMs: 250
  });
  if (!ready) throw new Error("搜索页候选人卡片未出现");
  return {
    ready: true
  };
}

export async function openSearchCardByIndex(client, index) {
  let result = await clickVisibleSearchCardByIndex(client, index, "card_content_click");
  if (!result.clicked) {
    throw new Error(`未找到可打开的搜索卡片 index=${index} cardCount=${result.cardCount}`);
  }
  let ready = await client.waitFor((selector) => {
    const node = document.querySelector(selector);
    return node && (node.textContent || node.innerText || "").trim().length > 100;
  }, [searchSelectors.modalPrintable], {
    timeoutMs: 8000,
    pollMs: 250
  });
  if (!ready) {
    result = await clickVisibleSearchCardByIndex(client, index, "card_wrap_mouse_events");
    ready = await client.waitFor((selector) => {
      const node = document.querySelector(selector);
      return node && (node.textContent || node.innerText || "").trim().length > 100;
    }, [searchSelectors.modalPrintable], {
      timeoutMs: 8000,
      pollMs: 250
    });
  }
  if (!ready) throw new Error("搜索详情弹窗未出现");
  return result;
}

async function clickVisibleSearchCardByIndex(client, index, method) {
  return client.evaluate((selectors, cardIndex, clickMethod) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const primaryCards = [...document.querySelectorAll(selectors.cardContent)]
      .filter((node) => visible(node) && getText(node).length > 20);
    const wrapCards = [...document.querySelectorAll(selectors.cardWrap)]
      .filter((node) => visible(node) && getText(node).length > 20);
    const cards = primaryCards.length > 0 ? primaryCards : wrapCards;
    const card = cards[cardIndex];
    if (!card) return { clicked: false, reason: "card_not_found", cardCount: cards.length, cardIndex };
    const wrap = card.closest("li") || card;
    const key = wrap.getAttribute("data-tlg-ext")
      || wrap.getAttribute("data-id")
      || wrap.getAttribute("data-key")
      || "";
    const target = clickMethod === "card_wrap_mouse_events" ? wrap : card;
    target.scrollIntoView({ block: "center" });
    const rect = target.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + Math.min(40, Math.max(1, rect.width / 2)),
      clientY: rect.top + Math.min(40, Math.max(1, rect.height / 2))
    };
    if (clickMethod === "card_wrap_mouse_events") {
      target.dispatchEvent(new MouseEvent("mouseover", eventInit));
      target.dispatchEvent(new MouseEvent("mousedown", eventInit));
      target.dispatchEvent(new MouseEvent("mouseup", eventInit));
      target.dispatchEvent(new MouseEvent("click", eventInit));
    } else {
      target.click();
    }
    return {
      clicked: true,
      method: clickMethod,
      cardIndex,
      cardCount: cards.length,
      key,
      cardHead: getText(card).slice(0, 160)
    };
  }, searchSelectors, index, method);
}

export async function readSearchModalSnapshot(client, {
  profile = "",
  pageNumber = null,
  cardIndex = null
} = {}) {
  const raw = await client.evaluate((selectors, context) => {
    const modalRoot = document.querySelector(selectors.modalRoot);
    const printable = document.querySelector(selectors.modalPrintable);
    if (!modalRoot || !printable) {
      throw new Error("Search modal is not open");
    }
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const fullText = printable.innerText || printable.textContent || "";
    const firstLine = fullText
      .split(/\n+/u)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find(Boolean) || "";
    return {
      sourceKind: "search_modal",
      captureSource: `search_profile_${context.profile || "unknown"}`,
      searchProfile: context.profile || "",
      pageNumber: context.pageNumber,
      cardIndex: context.cardIndex,
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
        .slice(0, 30),
      fullText,
      htmlLength: printable.innerHTML.length
    };
  }, searchSelectors, {
    profile: normalizeText(profile),
    pageNumber,
    cardIndex
  });
  return normalizeSnapshot(raw);
}

export async function readSearchChatButtonState(client) {
  return client.evaluate((selectors) => {
    const modalRoot = document.querySelector(selectors.modalRoot);
    const button = modalRoot?.querySelector(selectors.openChatButton)
      || document.querySelector(selectors.openChatButton);
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    return {
      exists: Boolean(button),
      text: getText(button),
      className: String(button?.className || ""),
      disabled: Boolean(button?.disabled || button?.getAttribute?.("aria-disabled") === "true")
    };
  }, searchSelectors);
}

export async function executeSearchChatAction(client, {
  jobTitle
} = {}) {
  const requestedJobTitle = normalizeText(jobTitle);
  if (!requestedJobTitle) throw new Error("搜索开聊职位不能为空");
  const before = await readSearchChatButtonState(client);
  if (isAlreadyContactedButtonText(before.text)) {
    return {
      ok: true,
      status: "already_contacted",
      clicked: false,
      before,
      selectedJob: null,
      confirm: null,
      after: before
    };
  }
  if (!isImmediateChatButtonText(before.text)) {
    return {
      ok: false,
      status: "chat_button_not_immediate",
      clicked: false,
      before,
      reason: before.exists ? `unexpected_button_text:${before.text}` : "button_not_found"
    };
  }
  if (before.disabled) {
    return {
      ok: false,
      status: "chat_button_disabled",
      clicked: false,
      before
    };
  }
  const click = await client.evaluate((selectors) => {
    const modalRoot = document.querySelector(selectors.modalRoot);
    const button = modalRoot?.querySelector(selectors.openChatButton)
      || document.querySelector(selectors.openChatButton);
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    if (!button) return { clicked: false, reason: "button_not_found" };
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      return { clicked: false, reason: "button_disabled", text: getText(button) };
    }
    button.scrollIntoView({ block: "center" });
    button.click();
    return {
      clicked: true,
      text: getText(button),
      className: String(button.className || "")
    };
  }, searchSelectors);
  if (!click.clicked) {
    return {
      ok: false,
      status: click.reason || "chat_button_not_clicked",
      clicked: false,
      before,
      click
    };
  }
  const serviceVisible = await waitForSearchServiceJobModal(client);
  if (!serviceVisible) {
    const after = await readSearchChatButtonState(client);
    if (isAlreadyContactedButtonText(after.text)) {
      return {
        ok: true,
        status: "search_contacted",
        clicked: true,
        before,
        click,
        selectedJob: null,
        confirm: null,
        modalClosed: true,
        after
      };
    }
    return {
      ok: false,
      status: "service_job_modal_not_found",
      clicked: true,
      before,
      click,
      after
    };
  }
  const selectedJob = await waitForSearchServiceJobSelection(client, requestedJobTitle);
  if (!selectedJob.clicked) {
    const after = await readSearchChatButtonState(client);
    if (isAlreadyContactedButtonText(after.text)) {
      return {
        ok: true,
        status: "search_contacted",
        clicked: true,
        before,
        click,
        selectedJob,
        confirm: null,
        modalClosed: true,
        after
      };
    }
    return {
      ok: false,
      status: "service_job_not_found",
      clicked: true,
      before,
      click,
      selectedJob,
      after
    };
  }
  await waitForSearchServiceJobConfirmEnabled(client, { timeoutMs: 4000 });
  const confirm = await confirmSearchServiceJobModal(client);
  const modalClosed = await client.waitFor((selectors) => {
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    return ![...document.querySelectorAll(selectors.serviceJobContainer)].some(visible);
  }, [searchSelectors], {
    timeoutMs: 8000,
    pollMs: 250
  });
  const after = await waitForSearchChatButtonState(client, {
    timeoutMs: 8000
  });
  const ok = Boolean(confirm.clicked && modalClosed && isAlreadyContactedButtonText(after.text));
  return {
    ok,
    status: ok ? "search_contacted" : "search_contact_state_not_verified",
    clicked: true,
    before,
    click,
    selectedJob,
    confirm,
    modalClosed: Boolean(modalClosed),
    after
  };
}

export async function waitForSearchChatButtonState(client, {
  timeoutMs = 8000,
  pollMs = 500
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = await readSearchChatButtonState(client);
  while (Date.now() < deadline) {
    if (isAlreadyContactedButtonText(latest.text)) return latest;
    await sleep(pollMs);
    latest = await readSearchChatButtonState(client);
  }
  return latest;
}

export async function waitForSearchServiceJobModal(client) {
  return client.waitFor((selectors) => {
    const container = document.querySelector(selectors.serviceJobContainer);
    if (!container) return false;
    const text = (container.innerText || container.textContent || "").replace(/\s+/g, " ").trim();
    const style = window.getComputedStyle(container);
    const rect = container.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && text.length > 0;
  }, [searchSelectors], {
    timeoutMs: 8000,
    pollMs: 250
  });
}

export async function waitForSearchServiceJobSelection(client, jobTitle, {
  timeoutMs = 8000,
  pollMs = 250
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    latest = await selectSearchServiceJob(client, jobTitle);
    if (latest.clicked) {
      return {
        ...latest,
        attempts
      };
    }
    await sleep(pollMs);
  }
  latest = latest || await selectSearchServiceJob(client, jobTitle);
  return {
    ...latest,
    attempts
  };
}

export async function selectSearchServiceJob(client, jobTitle) {
  return client.evaluate((selectors, requestedJobTitle) => {
    const normalize = (value) => String(value || "").replace(/[\u200B-\u200D\uFEFF]/gu, "").replace(/\s+/g, " ").trim();
    const getText = (node) => normalize(node?.innerText || node?.textContent || "");
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const container = document.querySelector(selectors.serviceJobContainer);
    const rowNodes = dedupeNodes([
      ...document.querySelectorAll(selectors.serviceJobRow),
      ...(container?.querySelectorAll(":scope > div > div > div") || []),
      ...(container?.querySelectorAll("[class*='jobListWrap'] li, li, [role='option']") || [])
    ]);
    const rows = rowNodes
      .filter(visible)
      .map((node, index) => ({
        index,
        node,
        title: getText(node),
        className: String(node.className || "")
      }))
      .filter((row) => row.title);
    const requested = normalize(requestedJobTitle);
    const match = matchJobRow(rows, requested);
    if (!match) {
      return {
        clicked: false,
        reason: "job_not_found",
        requested,
        availableJobs: rows.map((row) => row.title)
      };
    }
    match.node.scrollIntoView({ block: "center" });
    match.node.click();
    return {
      clicked: true,
      requested,
      selectedTitle: match.title,
      matchType: match.matchType,
      availableJobs: rows.map((row) => row.title)
    };

    function matchJobRow(rowsToMatch, text) {
      return matchByLooseText(rowsToMatch, text);
    }

    function normalizeLoose(value) {
      const normalized = normalize(value);
      const nfkc = typeof normalized.normalize === "function" ? normalized.normalize("NFKC") : normalized;
      return nfkc
        .replace(/[\u200B-\u200D\uFEFF]/gu, "")
        .replace(/[（]/gu, "(")
        .replace(/[）]/gu, ")")
        .replace(/\s+/gu, "")
        .toLowerCase();
    }

    function matchByLooseText(items, text) {
      const requestedLoose = normalizeLoose(text);
      return items
        .map((item) => {
          const title = normalize(item.title);
          const looseTitle = normalizeLoose(title);
          let score = 0;
          let matchType = "none";
          if (title === text) {
            score = 100;
            matchType = "exact";
          } else if (looseTitle === requestedLoose) {
            score = 95;
            matchType = "loose_exact";
          } else if (looseTitle.startsWith(requestedLoose) || requestedLoose.startsWith(looseTitle)) {
            score = 80;
            matchType = "loose_prefix";
          } else if (looseTitle.includes(requestedLoose) || requestedLoose.includes(looseTitle)) {
            score = 70;
            matchType = "loose_includes";
          } else {
            const tokenScore = tokenCoverageScore(title, text);
            if (tokenScore >= 0.7) {
              score = 60 + Math.round(tokenScore * 10);
              matchType = "token_coverage";
            }
          }
          return {
            ...item,
            title,
            score,
            matchType,
            distance: Math.abs(looseTitle.length - requestedLoose.length)
          };
        })
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.distance - right.distance || left.index - right.index)[0] || null;
    }

    function tokenCoverageScore(candidateText, requestedText) {
      const candidateLoose = normalizeLoose(candidateText);
      const tokens = extractLooseTokens(requestedText);
      if (!tokens.length) return 0;
      const hits = tokens.filter((token) => candidateLoose.includes(token) || candidateLoose.includes(simplifyToken(token)));
      return hits.length / tokens.length;
    }

    function extractLooseTokens(value) {
      return normalize(value)
        .normalize("NFKC")
        .replace(/[（]/gu, "(")
        .replace(/[）]/gu, ")")
        .split(/[·,，;；|、\s]+/u)
        .map((token) => normalizeLoose(token))
        .map(simplifyToken)
        .filter((token) => token.length >= 2);
    }

    function simplifyToken(token) {
      return String(token || "")
        .replace(/及以上$/u, "")
        .replace(/及以下$/u, "");
    }

    function dedupeNodes(nodes) {
      const seen = new Set();
      const result = [];
      for (const node of nodes) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        result.push(node);
      }
      return result;
    }
  }, searchSelectors, jobTitle);
}

export async function waitForSearchServiceJobConfirmEnabled(client, {
  timeoutMs = 4000,
  pollMs = 200
} = {}) {
  return client.waitFor((selectors) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const getText = (node) => normalize(node?.innerText || node?.textContent || "");
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const container = document.querySelector(selectors.serviceJobContainer);
    const modal = container?.closest(".ant-lpt-modal-content")
      || [...document.querySelectorAll(".ant-lpt-modal-content, [role='dialog']")]
        .find((node) => visible(node) && getText(node).includes("请选择开聊职位"));
    if (!modal) return false;
    const buttons = [...modal.querySelectorAll("button")].filter(visible);
    const confirm = buttons.find((node) => getText(node) === "确认")
      || buttons.find((node) => getText(node).includes("确认") && String(node.className || "").includes("primary"))
      || buttons.find((node) => String(node.className || "").includes("primary"));
    return Boolean(confirm && !confirm.disabled && confirm.getAttribute("aria-disabled") !== "true");
  }, [searchSelectors], {
    timeoutMs,
    pollMs
  });
}

export async function confirmSearchServiceJobModal(client) {
  return client.evaluate((selectors) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const getText = (node) => normalize(node?.innerText || node?.textContent || "");
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const container = document.querySelector(selectors.serviceJobContainer);
    const modal = container?.closest(".ant-lpt-modal-content")
      || [...document.querySelectorAll(".ant-lpt-modal-content, [role='dialog']")]
        .find((node) => visible(node) && getText(node).includes("请选择开聊职位"));
    if (!modal) {
      return {
        clicked: false,
        reason: "modal_not_found"
      };
    }
    const buttons = [...modal.querySelectorAll("button")]
      .filter((node) => visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true");
    const confirm = buttons.find((node) => getText(node) === "确认")
      || buttons.find((node) => getText(node).includes("确认") && String(node.className || "").includes("primary"))
      || buttons.find((node) => String(node.className || "").includes("primary"));
    if (!confirm) {
      return {
        clicked: false,
        reason: "confirm_button_not_found",
        buttonTexts: buttons.map((node) => getText(node))
      };
    }
    confirm.scrollIntoView({ block: "center" });
    confirm.click();
    return {
      clicked: true,
      text: getText(confirm),
      className: String(confirm.className || "")
    };
  }, searchSelectors);
}

export async function closeSearchModalToList(client) {
  await closeSearchServiceJobModalIfOpen(client);
  const before = await client.evaluate((selectors) => Boolean(document.querySelector(selectors.modalRoot)), searchSelectors);
  if (!before) {
    return {
      closed: true,
      closeMethod: "already_closed"
    };
  }
  const click = await client.evaluate((selectors) => {
    const button = document.querySelector(selectors.modalCloseButton);
    if (!button) {
      return {
        clicked: false,
        reason: "close_button_not_found"
      };
    }
    button.scrollIntoView({ block: "center" });
    button.click();
    return {
      clicked: true,
      className: String(button.className || "")
    };
  }, searchSelectors);
  const closed = await client.waitFor((selector) => {
    const node = document.querySelector(selector);
    if (!node) return true;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0;
  }, [searchSelectors.modalRoot], {
    timeoutMs: 7000,
    pollMs: 250
  });
  if (!closed) {
    await pressSearchEscapeKey(client);
    const closedByEscape = await client.waitFor((selector) => {
      const node = document.querySelector(selector);
      if (!node) return true;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0;
    }, [searchSelectors.modalRoot], {
      timeoutMs: 3000,
      pollMs: 250
    });
    return {
      closed: Boolean(closedByEscape),
      closeMethod: click.clicked ? "close_button+escape" : "escape",
      click
    };
  }
  return {
    closed: Boolean(closed),
    closeMethod: click.clicked ? "close_button" : "none",
    click
  };
}

async function pressSearchEscapeKey(client) {
  const event = {
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
    code: "Escape",
    key: "Escape"
  };
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...event
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...event
  });
}

async function closeSearchServiceJobModalIfOpen(client) {
  const result = await client.evaluate((selectors) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const getText = (node) => normalize(node?.innerText || node?.textContent || "");
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const container = document.querySelector(selectors.serviceJobContainer);
    const modal = container?.closest(".ant-lpt-modal-content")
      || [...document.querySelectorAll(".ant-lpt-modal-content, [role='dialog']")]
        .find((node) => visible(node) && getText(node).includes("请选择开聊职位"));
    if (!modal || !visible(modal)) return { clicked: false, reason: "modal_not_open" };
    const close = modal.querySelector(".ant-lpt-modal-close, [aria-label='Close'], [class*='modal-close']");
    const buttons = [...modal.querySelectorAll("button")].filter((node) => visible(node) && !node.disabled);
    const cancel = buttons.find((node) => getText(node) === "取消")
      || buttons.find((node) => getText(node).includes("取消"));
    const target = cancel || close;
    if (!target) return { clicked: false, reason: "close_button_not_found" };
    target.click();
    return {
      clicked: true,
      text: getText(target),
      className: String(target.className || "")
    };
  }, searchSelectors);
  if (!result.clicked) return result;
  const closed = await client.waitFor((selectors) => {
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    return ![...document.querySelectorAll(selectors.serviceJobContainer)].some(visible);
  }, [searchSelectors], {
    timeoutMs: 3000,
    pollMs: 200
  });
  return {
    ...result,
    closed: Boolean(closed)
  };
}

export async function readSearchPaginationState(client) {
  return client.evaluate((selectors) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const pagebar = document.querySelector(selectors.pagebar);
    const next = document.querySelector(selectors.nextPageButton);
    const disabledNext = document.querySelector(selectors.disabledNextPageButton);
    const items = [...(pagebar?.querySelectorAll("li") || [])].map((node, index) => ({
      index,
      text: getText(node),
      className: String(node.className || ""),
      ariaDisabled: node.getAttribute("aria-disabled") || "",
      active: String(node.className || "").includes("active")
    }));
    const active = items.find((item) => item.active) || null;
    return {
      exists: Boolean(pagebar),
      activePageText: active?.text || "",
      items,
      nextExists: Boolean(next),
      nextDisabled: Boolean(
        disabledNext
        || next?.getAttribute("aria-disabled") === "true"
        || String(next?.className || "").includes("disabled")
      ),
      nextClassName: String(next?.className || ""),
      nextAriaDisabled: next?.getAttribute("aria-disabled") || ""
    };
  }, searchSelectors);
}

export async function clickSearchNextPage(client) {
  const before = await readSearchPaginationState(client);
  const beforeList = await readSearchListState(client);
  if (!before.nextExists || before.nextDisabled) {
    return {
      clicked: false,
      reason: before.nextExists ? "next_disabled" : "next_not_found",
      before,
      beforeList
    };
  }
  const click = await client.evaluate((selector) => {
    const next = document.querySelector(selector);
    if (!next) return { clicked: false, reason: "next_not_found" };
    if (next.getAttribute("aria-disabled") === "true" || String(next.className || "").includes("disabled")) {
      return { clicked: false, reason: "next_disabled" };
    }
    next.scrollIntoView({ block: "center" });
    next.click();
    return {
      clicked: true,
      className: String(next.className || "")
    };
  }, searchSelectors.nextPageButton);
  if (!click.clicked) {
    return {
      clicked: false,
      reason: click.reason || "next_not_clicked",
      click,
      before,
      beforeList
    };
  }
  await waitForSearchListRefresh(client, beforeList, { timeoutMs: 15000 });
  const after = await readSearchPaginationState(client);
  const afterList = await readSearchListState(client);
  return {
    clicked: true,
    click,
    before,
    after,
    beforeList,
    afterList,
    verified: after.activePageText !== before.activePageText || afterList.firstCardHash !== beforeList.firstCardHash
  };
}

export function isImmediateChatButtonText(text) {
  return normalizeText(text).includes("立即沟通");
}

export function isAlreadyContactedButtonText(text) {
  return normalizeText(text).includes("继续沟通");
}
