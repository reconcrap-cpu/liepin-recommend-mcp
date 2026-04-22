import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecommendFilterPlan,
  evaluateRecommendFilterExecution,
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
