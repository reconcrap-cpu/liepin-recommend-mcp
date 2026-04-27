import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecommendFilterPlanFromText,
  buildRecommendFilterPlan,
  evaluateRecommendFilterExecution,
  shouldApplyRecommendFilter,
  summarizeRecommendFilterExecution
} from "./recommend-filter-executor.js";

test("buildRecommendFilterPlan expands the P17 verified preset", () => {
  const plan = buildRecommendFilterPlan({ preset: "p17" });

  assert.equal(plan.length, 6);
  assert.deepEqual(plan.map((item) => item.key), [
    "graduation_year",
    "education",
    "salary_range",
    "age",
    "school_tier",
    "job_status"
  ]);
  assert.deepEqual(plan.find((item) => item.key === "age").values, ["20", "30"]);
});

test("buildRecommendFilterPlan omits empty custom filters", () => {
  const plan = buildRecommendFilterPlan({
    education: "本科",
    ageMin: "20"
  });

  assert.deepEqual(plan, [
    {
      key: "education",
      title: "学历要求",
      type: "tag",
      option: "本科"
    },
    {
      key: "age",
      title: "年龄",
      type: "range_input",
      values: ["20", ""]
    }
  ]);
});

test("buildRecommendFilterPlan expands delimited tag filters", () => {
  const plan = buildRecommendFilterPlan({
    education: "本科、硕士、MBA/EMBA、博士",
    schoolTier: "985、211、双一流院校、海外名校",
    jobStatus: "在校，可即刻到岗"
  });

  assert.deepEqual(plan, [
    {
      key: "education",
      title: "学历要求",
      type: "tag",
      option: "本科"
    },
    {
      key: "education",
      title: "学历要求",
      type: "tag",
      option: "硕士"
    },
    {
      key: "education",
      title: "学历要求",
      type: "tag",
      option: "MBA/EMBA"
    },
    {
      key: "education",
      title: "学历要求",
      type: "tag",
      option: "博士"
    },
    {
      key: "school_tier",
      title: "院校",
      type: "tag",
      option: "985"
    },
    {
      key: "school_tier",
      title: "院校",
      type: "tag",
      option: "211"
    },
    {
      key: "school_tier",
      title: "院校",
      type: "tag",
      option: "双一流院校"
    },
    {
      key: "school_tier",
      title: "院校",
      type: "tag",
      option: "海外名校"
    },
    {
      key: "job_status",
      title: "求职状态",
      type: "tag",
      option: "在校，可即刻到岗"
    }
  ]);
});

test("buildRecommendFilterPlanFromText understands JSON and natural language filters", () => {
  assert.deepEqual(buildRecommendFilterPlanFromText(
    "{\"education\":[\"本科\",\"硕士\"],\"age\":{\"min\":22,\"max\":30},\"school_tier\":[\"985\",\"211\"]}"
  ), [
    {
      key: "education",
      title: "学历要求",
      type: "tag",
      option: "本科"
    },
    {
      key: "education",
      title: "学历要求",
      type: "tag",
      option: "硕士"
    },
    {
      key: "age",
      title: "年龄",
      type: "range_input",
      values: ["22", "30"]
    },
    {
      key: "school_tier",
      title: "院校",
      type: "tag",
      option: "985"
    },
    {
      key: "school_tier",
      title: "院校",
      type: "tag",
      option: "211"
    }
  ]);

  assert.deepEqual(buildRecommendFilterPlanFromText("学历=本科、硕士; 年龄=22-30; 院校=985、211"), [
    {
      key: "education",
      title: "学历要求",
      type: "tag",
      option: "本科"
    },
    {
      key: "education",
      title: "学历要求",
      type: "tag",
      option: "硕士"
    },
    {
      key: "age",
      title: "年龄",
      type: "range_input",
      values: ["22", "30"]
    },
    {
      key: "school_tier",
      title: "院校",
      type: "tag",
      option: "985"
    },
    {
      key: "school_tier",
      title: "院校",
      type: "tag",
      option: "211"
    }
  ]);
});

test("shouldApplyRecommendFilter treats current-page labels as no-op", () => {
  assert.equal(shouldApplyRecommendFilter("沿用页面当前筛选"), false);
  assert.equal(shouldApplyRecommendFilter("不额外筛选"), false);
  assert.equal(shouldApplyRecommendFilter("学历=本科"), true);
});

test("evaluateRecommendFilterExecution requires apply, verified actions, and restore", () => {
  const result = {
    clearOnly: false,
    restore: true,
    requestedPlan: [
      { key: "education" },
      { key: "age" }
    ],
    resetBeforeApply: true,
    apply: { clicked: true },
    actions: [
      {
        key: "education",
        type: "tag",
        setAction: { clicked: true },
        verified: true
      },
      {
        key: "age",
        type: "range_input",
        setAction: { changed: true },
        verified: true
      }
    ],
    restoreResult: {
      reset: true,
      apply: { clicked: true },
      drawerBeforeRestoreApply: { selected: [] }
    }
  };

  assert.deepEqual(evaluateRecommendFilterExecution(result), {
    passed: true,
    failures: []
  });
  assert.equal(summarizeRecommendFilterExecution({ ...result, passed: true }).ok, true);
});
