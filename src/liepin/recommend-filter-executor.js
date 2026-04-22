import { createPageClient, discoverLiepinPages, isLiepinRiskPageUrl } from "../chrome.js";
import { DEFAULT_DEBUG_PORT } from "../constants.js";
import { normalizeText, sleep } from "../utils.js";
import { RECOMMEND_FILTER_SPECS } from "./recommend-filter-discovery.js";
import { clearRecommendBlockingOverlaysToList } from "./recommend-return.js";
import { recommendSelectors } from "./selectors.js";

export const RECOMMEND_FILTER_EXECUTION_SCHEMA_VERSION = "liepin_recommend_filter_execution_v1";

export function buildRecommendFilterPlan({
  preset = "",
  graduationYear = "",
  education = "",
  salaryRange = "",
  ageMin = "",
  ageMax = "",
  schoolTier = "",
  jobStatus = ""
} = {}) {
  if (normalizeText(preset).toLowerCase() === "p17") {
    return RECOMMEND_FILTER_SPECS.map((spec) => {
      if (spec.type === "range_input") {
        return {
          key: spec.key,
          title: spec.title,
          type: spec.type,
          values: spec.testValues
        };
      }
      return {
        key: spec.key,
        title: spec.title,
        type: spec.type,
        option: spec.testOption
      };
    });
  }

  return [
    buildTagAction("graduation_year", graduationYear),
    buildTagAction("education", education),
    buildTagAction("salary_range", salaryRange),
    buildRangeAction("age", [ageMin, ageMax]),
    buildTagAction("school_tier", schoolTier),
    buildTagAction("job_status", jobStatus)
  ].filter(Boolean);
}

export async function executeRecommendFilters({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  plan = [],
  restore = true,
  clearOnly = false
} = {}) {
  const pages = await discoverLiepinPages({ port });
  if (!pages.recommend && pages.riskPage) {
    throw new Error(`检测到猎聘风控/验证码页，已停止推荐筛选执行：${pages.riskPage.url}`);
  }
  if (!pages.recommend) {
    throw new Error("未找到猎聘推荐页，请先在 Chrome 9222 打开 https://lpt.liepin.com/recommend");
  }

  const client = await createPageClient(pages.recommend);
  try {
    await assertNotRiskPage(client, "推荐筛选执行");
    await closeRecommendOverlays(client);
    const beforeList = await readRecommendListState(client);

    await ensureRecommendFilterDrawerOpen(client);
    const resetBeforeApply = await resetRecommendFilterDrawer(client);
    await sleep(300);

    const actions = clearOnly ? [] : await applyRecommendFilterPlan(client, plan);
    const drawerBeforeApply = await readRecommendActiveDrawerState(client);
    const applyResult = await clickRecommendFilterApply(client);
    await sleep(1500);
    await assertNotRiskPage(client, "推荐筛选应用后检查");
    const afterApplyList = await readRecommendListState(client);

    let restoreResult = null;
    if (restore) {
      await ensureRecommendFilterDrawerOpen(client);
      const reset = await resetRecommendFilterDrawer(client);
      await sleep(300);
      const drawerBeforeRestoreApply = await readRecommendActiveDrawerState(client);
      const restoreApply = await clickRecommendFilterApply(client);
      await sleep(1500);
      await assertNotRiskPage(client, "推荐筛选恢复后检查");
      const afterRestoreList = await readRecommendListState(client);
      restoreResult = {
        reset,
        drawerBeforeRestoreApply,
        apply: restoreApply,
        afterRestoreList
      };
    }

    const result = {
      schemaVersion: RECOMMEND_FILTER_EXECUTION_SCHEMA_VERSION,
      clearOnly,
      restore,
      requestedPlan: plan,
      beforeList,
      resetBeforeApply,
      actions,
      drawerBeforeApply,
      apply: applyResult,
      afterApplyList,
      restoreResult,
      riskBlocked: false
    };
    return {
      ...result,
      passed: evaluateRecommendFilterExecution(result).passed
    };
  } finally {
    await client.disconnect();
  }
}

export function summarizeRecommendFilterExecution(result) {
  const evaluation = evaluateRecommendFilterExecution(result);
  return {
    ok: Boolean(result?.passed),
    clearOnly: Boolean(result?.clearOnly),
    restore: Boolean(result?.restore),
    actionCount: Array.isArray(result?.actions) ? result.actions.length : 0,
    requestedCount: Array.isArray(result?.requestedPlan) ? result.requestedPlan.length : 0,
    applyClicked: Boolean(result?.apply?.clicked),
    restored: Boolean(result?.restoreResult?.apply?.clicked),
    selectedBeforeApply: result?.drawerBeforeApply?.selected || [],
    failures: evaluation.failures
  };
}

export function evaluateRecommendFilterExecution(result) {
  const failures = [];
  const requestedPlan = Array.isArray(result?.requestedPlan) ? result.requestedPlan : [];
  const actions = Array.isArray(result?.actions) ? result.actions : [];

  if (!result?.resetBeforeApply) failures.push("reset_before_apply_not_clicked");
  if (!result?.apply?.clicked) failures.push("apply_not_clicked");
  if (!result?.clearOnly && requestedPlan.length === 0) failures.push("empty_filter_plan");
  if (!result?.clearOnly && actions.length !== requestedPlan.length) failures.push("action_count_mismatch");
  for (const action of actions) {
    if (action.type === "range_input") {
      if (!action.setAction?.changed) failures.push(`${action.key}_range_not_changed`);
      if (!action.verified) failures.push(`${action.key}_range_not_verified`);
    } else {
      if (!action.setAction?.clicked) failures.push(`${action.key}_tag_not_clicked`);
      if (!action.verified) failures.push(`${action.key}_tag_not_verified`);
    }
  }
  if (result?.restore) {
    if (!result?.restoreResult?.reset) failures.push("restore_reset_not_clicked");
    if (!result?.restoreResult?.apply?.clicked) failures.push("restore_apply_not_clicked");
    const selectedAfterRestoreReset = result?.restoreResult?.drawerBeforeRestoreApply?.selected || [];
    if (selectedAfterRestoreReset.length > 0) failures.push("restore_left_selected_filters");
  }

  return {
    passed: failures.length === 0,
    failures
  };
}

function buildTagAction(key, option) {
  const spec = RECOMMEND_FILTER_SPECS.find((candidate) => candidate.key === key);
  const normalizedOption = normalizeText(option);
  if (!spec || !normalizedOption) return null;
  return {
    key: spec.key,
    title: spec.title,
    type: spec.type,
    option: normalizedOption
  };
}

function buildRangeAction(key, values) {
  const spec = RECOMMEND_FILTER_SPECS.find((candidate) => candidate.key === key);
  const normalizedValues = values.map((value) => normalizeText(value));
  if (!spec || normalizedValues.every((value) => !value)) return null;
  return {
    key: spec.key,
    title: spec.title,
    type: spec.type,
    values: normalizedValues
  };
}

async function applyRecommendFilterPlan(client, plan) {
  const actions = [];
  for (const action of plan) {
    await scrollFilterGroupIntoView(client, action.title);
    if (action.type === "range_input") {
      const setAction = await setRangeFilterValues(client, action.title, action.values || ["", ""]);
      await sleep(250);
      const state = await readFilterGroupState(client, action.title);
      actions.push({
        ...action,
        setAction,
        stateAfterSet: state,
        verified: state.inputs.map((input) => input.value).join("|") === (action.values || []).join("|")
      });
      continue;
    }
    const setAction = await clickFilterTag(client, action.title, action.option);
    await sleep(250);
    const state = await readFilterGroupState(client, action.title);
    const activeOption = state.tags.find((tag) => tag.text === action.option);
    actions.push({
      ...action,
      setAction,
      stateAfterSet: state,
      verified: Boolean(activeOption?.checked)
    });
  }
  return actions;
}

async function ensureRecommendFilterDrawerOpen(client) {
  const open = await client.evaluate(() => Boolean(document.querySelector(".ant-lpt-drawer-open .ant-lpt-drawer-body")));
  if (open) return;
  const clicked = await client.evaluate(() => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const button = [...document.querySelectorAll("button")].find((node) => getText(node).startsWith("筛选"));
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clicked) throw new Error("未找到推荐页筛选按钮");
  const ready = await client.waitFor(() => Boolean(document.querySelector(".ant-lpt-drawer-open .ant-lpt-drawer-body")), [], {
    timeoutMs: 5000,
    pollMs: 150
  });
  if (!ready) throw new Error("推荐筛选抽屉未打开");
  await sleep(500);
}

async function readRecommendActiveDrawerState(client) {
  return client.evaluate(() => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const classText = (node) => typeof node.className === "string" ? node.className : (node.getAttribute?.("class") || "");
    const checked = (node) => classText(node).includes("ant-lpt-tag-checkable-checked");
    const groups = [...document.querySelectorAll(".filterItems--XYlh8")].map((group) => {
      const title = getText(group.querySelector(".itemTitle--y3zfr"));
      const selectedTags = [...group.querySelectorAll(".ant-lpt-tag-checkable")]
        .filter((node) => checked(node) && getText(node) !== "不限")
        .map((node) => getText(node));
      const filledInputs = [...group.querySelectorAll("input")]
        .map((node, index) => ({ index, value: node.value || "" }))
        .filter((input) => input.value);
      return {
        title,
        selectedTags,
        filledInputs
      };
    });
    return {
      selected: groups.flatMap((group) => [
        ...group.selectedTags.map((option) => ({ title: group.title, option })),
        ...group.filledInputs.map((input) => ({ title: group.title, inputIndex: input.index, value: input.value }))
      ]),
      groups
    };
  });
}

async function scrollFilterGroupIntoView(client, title) {
  const ok = await client.evaluate((wantedTitle) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const matchesFilterTitle = (actualTitle, expectedTitle) => (
      actualTitle === expectedTitle || actualTitle.startsWith(expectedTitle) || expectedTitle.startsWith(actualTitle)
    );
    const group = [...document.querySelectorAll(".filterItems--XYlh8")]
      .find((node) => matchesFilterTitle(getText(node.querySelector(".itemTitle--y3zfr")), wantedTitle));
    if (!group) return false;
    group.scrollIntoView({ block: "center" });
    return true;
  }, title);
  if (!ok) throw new Error(`未找到推荐筛选分组：${title}`);
  await sleep(250);
}

async function clickFilterTag(client, title, optionText) {
  return client.evaluate(({ wantedTitle, wantedOption }) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const classText = (node) => typeof node.className === "string" ? node.className : (node.getAttribute?.("class") || "");
    const matchesFilterTitle = (actualTitle, expectedTitle) => (
      actualTitle === expectedTitle || actualTitle.startsWith(expectedTitle) || expectedTitle.startsWith(actualTitle)
    );
    const group = [...document.querySelectorAll(".filterItems--XYlh8")]
      .find((node) => matchesFilterTitle(getText(node.querySelector(".itemTitle--y3zfr")), wantedTitle));
    if (!group) return { clicked: false, reason: "group_not_found" };
    const tag = [...group.querySelectorAll(".ant-lpt-tag-checkable")]
      .find((node) => getText(node) === wantedOption);
    if (!tag) return { clicked: false, reason: "option_not_found" };
    tag.click();
    return {
      clicked: true,
      selector: ".filterItems--XYlh8 .ant-lpt-tag-checkable",
      optionText: wantedOption,
      classNameBefore: classText(tag)
    };
  }, {
    wantedTitle: title,
    wantedOption: optionText
  });
}

async function setRangeFilterValues(client, title, values) {
  return client.evaluate(({ wantedTitle, wantedValues }) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const matchesFilterTitle = (actualTitle, expectedTitle) => (
      actualTitle === expectedTitle || actualTitle.startsWith(expectedTitle) || expectedTitle.startsWith(actualTitle)
    );
    const group = [...document.querySelectorAll(".filterItems--XYlh8")]
      .find((node) => matchesFilterTitle(getText(node.querySelector(".itemTitle--y3zfr")), wantedTitle));
    if (!group) return { changed: false, reason: "group_not_found" };
    const inputs = [...group.querySelectorAll("input")];
    if (inputs.length < wantedValues.length) return { changed: false, reason: "input_not_found" };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    wantedValues.forEach((value, index) => {
      const input = inputs[index];
      if (setter) setter.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return {
      changed: true,
      selector: ".filterItems--XYlh8 input",
      values: wantedValues
    };
  }, {
    wantedTitle: title,
    wantedValues: values
  });
}

async function readFilterGroupState(client, title) {
  return client.evaluate((wantedTitle) => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const classText = (node) => typeof node.className === "string" ? node.className : (node.getAttribute?.("class") || "");
    const checked = (node) => classText(node).includes("ant-lpt-tag-checkable-checked");
    const matchesFilterTitle = (actualTitle, expectedTitle) => (
      actualTitle === expectedTitle || actualTitle.startsWith(expectedTitle) || expectedTitle.startsWith(actualTitle)
    );
    const group = [...document.querySelectorAll(".filterItems--XYlh8")]
      .find((node) => matchesFilterTitle(getText(node.querySelector(".itemTitle--y3zfr")), wantedTitle));
    if (!group) return { title: wantedTitle, found: false, tags: [], inputs: [] };
    return {
      title: wantedTitle,
      found: true,
      tags: [...group.querySelectorAll(".ant-lpt-tag-checkable")].map((node) => ({
        text: getText(node),
        className: classText(node),
        checked: checked(node)
      })),
      inputs: [...group.querySelectorAll("input")].map((node, index) => ({
        index,
        value: node.value || "",
        className: classText(node)
      }))
    };
  }, title);
}

async function resetRecommendFilterDrawer(client) {
  const clicked = await client.evaluate(() => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const button = [...document.querySelectorAll(".ant-lpt-drawer-open button")]
      .find((node) => getText(node) === "重置");
    if (!button) return false;
    button.click();
    return true;
  });
  if (clicked) await sleep(300);
  return clicked;
}

async function clickRecommendFilterApply(client) {
  const clicked = await client.evaluate(() => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const button = [...document.querySelectorAll(".ant-lpt-drawer-open button")]
      .find((node) => getText(node) === "确定");
    if (!button) return { clicked: false, reason: "apply_button_not_found" };
    button.click();
    return { clicked: true, text: getText(button) };
  });
  if (!clicked.clicked) return clicked;
  await client.waitFor(() => !document.querySelector(".ant-lpt-drawer-open .ant-lpt-drawer-body"), [], {
    timeoutMs: 5000,
    pollMs: 150
  });
  return clicked;
}

async function readRecommendListState(client) {
  return client.evaluate((cardSelector) => ({
    url: location.href,
    title: document.title,
    cardCount: document.querySelectorAll(cardSelector).length,
    scrollY: Math.round(window.scrollY || 0)
  }), recommendSelectors.card);
}

async function closeRecommendOverlays(client) {
  const cleanup = await clearRecommendBlockingOverlaysToList(client);
  if (!cleanup.closed) {
    throw new Error(`推荐页存在未关闭遮罩，且无法通过关闭弹层返回列表：${cleanup.reason || "unknown"}`);
  }
}

async function assertNotRiskPage(client, actionLabel) {
  const currentUrl = await client.evaluate(() => location.href);
  if (isLiepinRiskPageUrl(currentUrl)) {
    throw new Error(`检测到猎聘风控/验证码页，已停止${actionLabel}：${currentUrl}`);
  }
}
