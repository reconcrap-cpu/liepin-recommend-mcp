import test from "node:test";
import assert from "node:assert/strict";

import {
  SEARCH_CHAT_CHAIN_SCHEMA_VERSION,
  evaluateSearchChatChain,
  shouldExecuteSearchChat,
  summarizeSearchChatChain
} from "./search-chat-chain.js";

test("shouldExecuteSearchChat requires pass and chat post action", () => {
  assert.equal(shouldExecuteSearchChat({ decision: "pass", post_action: "chat" }), true);
  assert.equal(shouldExecuteSearchChat({ decision: "pass", post_action: "none" }), false);
  assert.equal(shouldExecuteSearchChat({ decision: "fail", post_action: "chat" }), false);
});

test("evaluateSearchChatChain counts only newly sent search greetings toward target", () => {
  const result = {
    schemaVersion: SEARCH_CHAT_CHAIN_SCHEMA_VERSION,
    profile: "测试",
    jobTitle: "招聘实习生",
    requestedCandidateLimit: 1,
    scannedCandidates: 2,
    passedCandidates: 2,
    greetedCandidates: 1,
    llmCalls: 2,
    communicationClicks: 1,
    actionClicks: 1,
    alreadyContactedCandidates: 1,
    violations: [],
    items: [
      {
        index: 0,
        llmCalled: true,
        decision: { decision: "pass", post_action: "chat" },
        chatAction: { ok: true, clicked: true, status: "search_contacted" },
        closeAction: { closed: true },
        status: "search_contacted"
      },
      {
        index: 1,
        llmCalled: true,
        decision: { decision: "pass", post_action: "chat" },
        chatAction: { ok: true, clicked: false, status: "already_contacted" },
        closeAction: { closed: true },
        status: "search_already_contacted"
      }
    ]
  };

  const evaluation = evaluateSearchChatChain(result);
  assert.equal(evaluation.passed, true);

  const summary = summarizeSearchChatChain({ ...result, passed: true });
  assert.equal(summary.ok, true);
  assert.equal(summary.greetedCandidates, 1);
  assert.equal(summary.communicationClicks, 1);
  assert.equal(summary.alreadyContactedCandidates, 1);
});

test("evaluateSearchChatChain fails when target is not reached", () => {
  const evaluation = evaluateSearchChatChain({
    schemaVersion: SEARCH_CHAT_CHAIN_SCHEMA_VERSION,
    profile: "测试",
    jobTitle: "招聘实习生",
    requestedCandidateLimit: 2,
    passedCandidates: 2,
    greetedCandidates: 1,
    violations: [],
    items: []
  });

  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.failures.includes("not_enough_search_greetings"), true);
});
