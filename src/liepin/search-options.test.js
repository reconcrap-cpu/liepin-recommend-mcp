import test from "node:test";
import assert from "node:assert/strict";

import {
  findSearchOptionMatch,
  normalizeSearchOptionTextForMatch,
  normalizeSearchProfiles,
  summarizeSearchOptions
} from "./search-options.js";

test("normalizeSearchProfiles returns unique profile titles without badge suffixes", () => {
  const profiles = normalizeSearchProfiles([
    { title: "测试新增", text: "测试 新增" },
    { title: "测试", text: "测试" },
    { title: "大模型infra", text: "大模型infra" },
    { title: "", text: "empty" }
  ]);

  assert.deepEqual(profiles.map((profile) => profile.title), ["测试", "大模型infra"]);
});

test("summarizeSearchOptions reports profiles jobs and checked job conditions", () => {
  const summary = summarizeSearchOptions({
    passed: true,
    profiles: [{ title: "测试" }, { title: "infra" }],
    jobs: [{ title: "招聘实习生" }],
    checkedJobConditions: [{ label: "工作城市 杭州" }]
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.profileCount, 2);
  assert.deepEqual(summary.profiles, ["测试", "infra"]);
  assert.equal(summary.jobCount, 1);
  assert.equal(summary.checkedJobConditionCount, 1);
});

test("findSearchOptionMatch tolerates agent formatting differences", () => {
  const options = [
    { title: "杭州算法" },
    { title: "科研算法工程师（大模型与AIGC方向）\u200b " }
  ];

  assert.equal(
    normalizeSearchOptionTextForMatch("科研算法工程师(大模型与 aigc 方向)"),
    "科研算法工程师(大模型与aigc方向)"
  );

  const match = findSearchOptionMatch(options, "科研算法工程师(大模型与 aigc 方向)");
  assert.equal(match.title, "科研算法工程师（大模型与AIGC方向）");
  assert.equal(match.matchType, "loose_exact");
});
