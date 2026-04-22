import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMockRecommendScreeningProvider,
  detectDryRunModalDrift,
  evaluateRecommendDryRunScreening,
  summarizeRecommendDryRunScreening
} from "./recommend-dry-run-screening.js";

test("buildMockRecommendScreeningProvider returns structured recommend decision", async () => {
  let reasoning = "";
  const provider = buildMockRecommendScreeningProvider({
    decision: "pass",
    postAction: "chat",
    reasoningText: "native reasoning\n"
  });

  const response = await provider({
    onReasoningDelta: (chunk) => {
      reasoning += chunk;
    }
  });

  assert.deepEqual(JSON.parse(response.content), {
    decision: "pass",
    post_action: "chat"
  });
  assert.equal(reasoning, "native reasoning\n");
});

test("evaluateRecommendDryRunScreening passes complete dry-run result", () => {
  const result = {
    dryRun: true,
    requestedCandidateLimit: 2,
    processedCandidates: 2,
    llmCalls: 2,
    actionClicks: 0,
    closeAction: { closed: true },
    violations: [],
    items: [
      {
        index: 0,
        textHash: "a",
        actionExecuted: false,
        coverage: { passed: true },
        decision: { decision: "fail", post_action: "none" }
      },
      {
        index: 1,
        textHash: "b",
        actionExecuted: false,
        coverage: { passed: true },
        decision: { decision: "pass", post_action: "chat" }
      }
    ]
  };

  assert.deepEqual(evaluateRecommendDryRunScreening(result), {
    passed: true,
    coveragePassed: true,
    failures: []
  });
});

test("summarizeRecommendDryRunScreening reports dry-run safety counters", () => {
  const summary = summarizeRecommendDryRunScreening({
    passed: true,
    dryRun: true,
    requestedCandidateLimit: 20,
    processedCandidates: 20,
    screenableCandidates: 20,
    llmCalls: 20,
    actionClicks: 0,
    closeAction: { closed: true },
    violations: [],
    items: Array.from({ length: 20 }, (_, index) => ({
      index,
      textHash: `hash-${index}`,
      actionExecuted: false,
      coverage: { passed: true },
      decision: { decision: "fail", post_action: "none" }
    }))
  });

  assert.deepEqual(summary, {
    ok: true,
    dryRun: true,
    processedCandidates: 20,
    screenableCandidates: 20,
    llmCalls: 20,
    actionClicks: 0,
    coveragePassed: true,
    closeVerified: true,
    violations: []
  });
});

test("detectDryRunModalDrift allows dynamic text hash changes for the same candidate", () => {
  const before = {
    textHash: "before",
    fullText: [
      "查看大图",
      "候选人A",
      "简历编号: abc123",
      "今天活跃"
    ].join("\n")
  };
  const after = {
    textHash: "after",
    fullText: [
      "查看大图",
      "候选人A",
      "简历编号: abc123",
      "在线"
    ].join("\n")
  };

  assert.equal(detectDryRunModalDrift(before, after, 0), null);
});

test("detectDryRunModalDrift rejects candidate identity changes", () => {
  const before = {
    textHash: "before",
    fullText: [
      "查看大图",
      "候选人A",
      "简历编号: abc123"
    ].join("\n")
  };
  const after = {
    textHash: "after",
    fullText: [
      "查看大图",
      "候选人B",
      "简历编号: def456"
    ].join("\n")
  };

  assert.equal(detectDryRunModalDrift(before, after, 0).code, "dry_run_candidate_identity_changed");
});
