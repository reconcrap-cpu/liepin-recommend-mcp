import assert from "node:assert/strict";
import test from "node:test";

import { buildMockChatScreeningProvider, summarizeChatDryRunScreening } from "./chat-dry-run-screening.js";

test("buildMockChatScreeningProvider returns structured chat decision", async () => {
  let reasoning = "";
  const provider = buildMockChatScreeningProvider({
    decision: "pass",
    postAction: "request_resume",
    reasoningText: "native reasoning\n"
  });

  const response = await provider({
    onReasoningDelta: (chunk) => {
      reasoning += chunk;
    }
  });

  assert.deepEqual(JSON.parse(response.content), {
    decision: "pass",
    post_action: "request_resume"
  });
  assert.equal(reasoning, "native reasoning\n");
});

test("summarizeChatDryRunScreening reports dry-run safety counters", () => {
  const summary = summarizeChatDryRunScreening({
    passed: true,
    dryRun: true,
    processedCandidates: 20,
    screenableCandidates: 6,
    skippedRows: 14,
    llmCalls: 6,
    actionClicks: 0,
    violations: []
  });

  assert.deepEqual(summary, {
    ok: true,
    dryRun: true,
    processedCandidates: 20,
    screenableCandidates: 6,
    skippedRows: 14,
    llmCalls: 6,
    actionClicks: 0,
    violations: []
  });
});
