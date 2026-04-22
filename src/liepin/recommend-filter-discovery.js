import { createPageClient, discoverLiepinPages, isLiepinRiskPageUrl } from "../chrome.js";
import { DEFAULT_DEBUG_PORT } from "../constants.js";
import { normalizeText, sleep } from "../utils.js";

export const RECOMMEND_FILTER_DISCOVERY_SCHEMA_VERSION = "liepin_recommend_filter_discovery_v1";

export const RECOMMEND_FILTER_SPECS = [
  {
    key: "graduation_year",
    title: "毕业年份",
    type: "tag",
    testOption: "2026",
    clearOption: "不限"
  },
  {
    key: "education",
    title: "学历要求",
    type: "tag",
    testOption: "本科",
    clearOption: "不限"
  },
  {
    key: "salary_range",
    title: "薪资范围（单选）",
    type: "tag_single",
    testOption: "5-8K",
    clearOption: "不限",
    unsupportedOptions: ["自定义"]
  },
  {
    key: "age",
    title: "年龄",
    type: "range_input",
    testValues: ["20", "30"]
  },
  {
    key: "school_tier",
    title: "院校",
    type: "tag",
    testOption: "985",
    clearOption: "不限"
  },
  {
    key: "job_status",
    title: "求职状态",
    type: "tag",
    testOption: "在校，可即刻到岗",
    clearOption: "不限"
  }
];

export async function discoverRecommendFilters({
  port = DEFAULT_DEBUG_PORT
} = {}, {
  verify = true
} = {}) {
  const pages = await discoverLiepinPages({ port });
  if (!pages.recommend && pages.riskPage) {
    throw new Error(`检测到猎聘风控/验证码页，已停止推荐筛选发现：${pages.riskPage.url}`);
  }
  if (!pages.recommend) {
    throw new Error("未找到猎聘推荐页，请先在 Chrome 9222 打开 https://lpt.liepin.com/recommend");
  }
  const client = await createPageClient(pages.recommend);
  try {
    const currentUrl = await client.evaluate(() => location.href);
    if (isLiepinRiskPageUrl(currentUrl)) {
      throw new Error(`检测到猎聘风控/验证码页，已停止推荐筛选发现：${currentUrl}`);
    }
    await ensureRecommendFilterDrawerOpen(client);
    const taxonomy = await readRecommendFilterTaxonomy(client);
    const verifications = verify ? await verifyRecommendFilterSpecs(client, RECOMMEND_FILTER_SPECS) : [];
    await resetRecommendFilterDrawer(client);
    await closeRecommendFilterDrawer(client);

    const result = {
      schemaVersion: RECOMMEND_FILTER_DISCOVERY_SCHEMA_VERSION,
      drawer: taxonomy.drawer,
      filters: taxonomy.filters,
      supportedFilters: RECOMMEND_FILTER_SPECS,
      verifications,
      unsupported: [
        {
          key: "salary_range_custom",
          title: "薪资范围",
          option: "自定义",
          reason: "custom salary inputs are not verified for v1"
        }
      ],
      riskBlocked: false
    };
    return {
      ...result,
      passed: verifications.length === RECOMMEND_FILTER_SPECS.length
        && verifications.every((item) => item.setOk && item.clearOk)
    };
  } finally {
    await client.disconnect();
  }
}

export function summarizeRecommendFilterDiscovery(result) {
  return {
    ok: Boolean(result?.passed),
    filterCount: Array.isArray(result?.filters) ? result.filters.length : 0,
    verifiedCount: Array.isArray(result?.verifications)
      ? result.verifications.filter((item) => item.setOk && item.clearOk).length
      : 0,
    supportedKeys: Array.isArray(result?.supportedFilters)
      ? result.supportedFilters.map((item) => item.key)
      : [],
    unsupported: result?.unsupported || []
  };
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

async function readRecommendFilterTaxonomy(client) {
  return client.evaluate(() => {
    const getText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const classText = (node) => typeof node.className === "string" ? node.className : (node.getAttribute?.("class") || "");
    const checked = (node) => classText(node).includes("ant-lpt-tag-checkable-checked");
    const drawer = document.querySelector(".ant-lpt-drawer-open");
    const body = document.querySelector(".ant-lpt-drawer-body");
    const filters = [...document.querySelectorAll(".filterItems--XYlh8")].map((group) => {
      const title = getText(group.querySelector(".itemTitle--y3zfr"));
      const tags = [...group.querySelectorAll(".ant-lpt-tag-checkable")].map((node) => ({
        text: getText(node),
        className: classText(node),
        checked: checked(node)
      }));
      const inputs = [...group.querySelectorAll("input")].map((node, index) => ({
        index,
        className: classText(node),
        value: node.value || "",
        placeholder: node.getAttribute("placeholder") || ""
      }));
      return {
        title,
        text: getText(group),
        tags,
        inputs
      };
    });
    return {
      drawer: {
        open: Boolean(drawer),
        rootSelector: ".ant-lpt-drawer-open",
        bodySelector: ".ant-lpt-drawer-body",
        groupSelector: ".filterItems--XYlh8",
        titleSelector: ".itemTitle--y3zfr",
        tagSelector: ".ant-lpt-tag-checkable",
        checkedClass: "ant-lpt-tag-checkable-checked",
        resetButtonText: "重置",
        applyButtonText: "确定",
        closeSelector: ".ant-lpt-drawer-close",
        scrollHeight: body?.scrollHeight || 0,
        clientHeight: body?.clientHeight || 0
      },
      filters
    };
  });
}

async function verifyRecommendFilterSpecs(client, specs) {
  const verifications = [];
  await resetRecommendFilterDrawer(client);
  for (const spec of specs) {
    if (spec.type === "range_input") {
      verifications.push(await verifyRangeFilter(client, spec));
    } else {
      verifications.push(await verifyTagFilter(client, spec));
    }
  }
  return verifications;
}

async function verifyTagFilter(client, spec) {
  await scrollFilterGroupIntoView(client, spec.title);
  const setState = await clickFilterTag(client, spec.title, spec.testOption);
  await sleep(250);
  const selected = await readFilterGroupState(client, spec.title);
  const activeOption = selected.tags.find((tag) => tag.text === spec.testOption);
  const setOk = Boolean(activeOption?.checked);

  const clearState = await clickFilterTag(client, spec.title, spec.clearOption);
  await sleep(250);
  const cleared = await readFilterGroupState(client, spec.title);
  const clearOption = cleared.tags.find((tag) => tag.text === spec.clearOption);
  const testOption = cleared.tags.find((tag) => tag.text === spec.testOption);
  const clearOk = Boolean(clearOption?.checked) && !testOption?.checked;

  return {
    key: spec.key,
    title: spec.title,
    type: spec.type,
    option: spec.testOption,
    setAction: setState,
    clearAction: clearState,
    activeStateClass: "ant-lpt-tag-checkable-checked",
    setOk,
    clearOk,
    unsupportedOptions: spec.unsupportedOptions || []
  };
}

async function verifyRangeFilter(client, spec) {
  await scrollFilterGroupIntoView(client, spec.title);
  const setState = await setRangeFilterValues(client, spec.title, spec.testValues);
  await sleep(250);
  const selected = await readFilterGroupState(client, spec.title);
  const setOk = selected.inputs.map((input) => input.value).join("|") === spec.testValues.join("|");

  const clearState = await setRangeFilterValues(client, spec.title, ["", ""]);
  await sleep(250);
  const cleared = await readFilterGroupState(client, spec.title);
  const clearOk = cleared.inputs.every((input) => !input.value);

  return {
    key: spec.key,
    title: spec.title,
    type: spec.type,
    values: spec.testValues,
    setAction: setState,
    clearAction: clearState,
    activeStateClass: "input value",
    setOk,
    clearOk
  };
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

async function closeRecommendFilterDrawer(client) {
  const clicked = await client.evaluate(() => {
    const button = document.querySelector(".ant-lpt-drawer-open .ant-lpt-drawer-close");
    if (!button) return false;
    button.click();
    return true;
  });
  if (clicked) await sleep(300);
  return clicked;
}
