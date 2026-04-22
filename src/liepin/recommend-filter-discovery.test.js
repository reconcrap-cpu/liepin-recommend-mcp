import assert from "node:assert/strict";
import test from "node:test";

import { RECOMMEND_FILTER_SPECS, summarizeRecommendFilterDiscovery } from "./recommend-filter-discovery.js";

test("RECOMMEND_FILTER_SPECS keeps only verified v1 filter shapes", () => {
  assert.deepEqual(RECOMMEND_FILTER_SPECS.map((item) => item.key), [
    "graduation_year",
    "education",
    "salary_range",
    "age",
    "school_tier",
    "job_status"
  ]);
  assert.equal(RECOMMEND_FILTER_SPECS.find((item) => item.key === "salary_range").unsupportedOptions.includes("自定义"), true);
});

test("summarizeRecommendFilterDiscovery reports verified filters", () => {
  const summary = summarizeRecommendFilterDiscovery({
    passed: true,
    filters: [{ title: "毕业年份" }],
    supportedFilters: RECOMMEND_FILTER_SPECS,
    verifications: RECOMMEND_FILTER_SPECS.map((spec) => ({
      key: spec.key,
      setOk: true,
      clearOk: true
    })),
    unsupported: []
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.filterCount, 1);
  assert.equal(summary.verifiedCount, 6);
  assert.equal(summary.supportedKeys.includes("age"), true);
});
