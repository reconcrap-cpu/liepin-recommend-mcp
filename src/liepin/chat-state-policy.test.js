import assert from "node:assert/strict";
import test from "node:test";

import { classifyChatScreeningEligibility, summarizeChatScreeningPolicy } from "./chat-state-policy.js";

test("classifyChatScreeningEligibility only allows candidate 索要简历", () => {
  assert.equal(classifyChatScreeningEligibility({
    rowType: "candidate",
    resumeState: "索要简历"
  }).shouldCallLlm, true);

  for (const resumeState of ["索要中", "看简历", "浏览简历", "UNKNOWN"]) {
    const decision = classifyChatScreeningEligibility({
      rowType: "candidate",
      resumeState
    });
    assert.equal(decision.screeningStatus, "skip");
    assert.equal(decision.shouldCallLlm, false);
  }

  const systemDecision = classifyChatScreeningEligibility({
    rowType: "system",
    resumeState: "索要简历"
  });
  assert.equal(systemDecision.screeningStatus, "skip");
  assert.equal(systemDecision.shouldCallLlm, false);
  assert.equal(systemDecision.skipReason, "non_candidate_row");
});

test("summarizeChatScreeningPolicy reports no violations for expected states", () => {
  const summary = summarizeChatScreeningPolicy([
    { rowType: "candidate", resumeState: "索要简历" },
    { rowType: "candidate", resumeState: "索要中" },
    { rowType: "candidate", resumeState: "看简历" },
    { rowType: "system", resumeState: "浏览简历" }
  ]);

  assert.equal(summary.passed, true);
  assert.equal(summary.counts.screenable, 1);
  assert.equal(summary.counts.skip, 3);
  assert.deepEqual(summary.violations, []);
});
