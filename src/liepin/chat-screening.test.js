import test from "node:test";
import assert from "node:assert/strict";

import {
  isChatRequestSuccessState,
  requestResumeWithRetry,
  resolveChatScreeningScrollStopReason,
  shouldRequestResumeForDecision,
  summarizeChatScreening
} from "./chat-screening.js";

test("shouldRequestResumeForDecision only executes for pass + request_resume", () => {
  assert.equal(shouldRequestResumeForDecision({ decision: "pass", post_action: "request_resume" }), true);
  assert.equal(shouldRequestResumeForDecision({ decision: "pass", post_action: "none" }), false);
  assert.equal(shouldRequestResumeForDecision({ decision: "fail", post_action: "request_resume" }), false);
});

test("isChatRequestSuccessState accepts pending button or newly inserted success message", () => {
  assert.equal(isChatRequestSuccessState(
    { resumeState: "索要简历", successMessageCount: 0 },
    { resumeState: "索要中", successMessageCount: 0 }
  ), true);
  assert.equal(isChatRequestSuccessState(
    { resumeState: "索要简历", successMessageCount: 1 },
    { resumeState: "索要简历", successMessageCount: 2, latestSuccessMessage: "我想要一份你的简历" }
  ), true);
  assert.equal(isChatRequestSuccessState(
    { resumeState: "索要简历", successMessageCount: 1 },
    { resumeState: "索要简历", successMessageCount: 1, latestSuccessMessage: "我想要一份你的简历" }
  ), false);
});

test("requestResumeWithRetry retries until the request becomes pending", async () => {
  const client = createRequestResumeFakeClient([
    { resumeState: "索要简历", successMessageCount: 0 },
    { resumeState: "索要简历", successMessageCount: 0 },
    { resumeState: "索要简历", successMessageCount: 0 },
    { resumeState: "索要简历", successMessageCount: 0 },
    { resumeState: "索要中", successMessageCount: 0 }
  ]);

  const result = await requestResumeWithRetry(client, {
    beforeState: { rowKey: "candidate-1", resumeState: "索要简历" },
    maxAttempts: 3,
    clickSettleMs: 0,
    verifyDelayMs: 0,
    retryDelayMs: 0
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "request_resume_succeeded");
  assert.equal(result.clickedAttempts, 2);
  assert.equal(result.attempts.length, 2);
  assert.equal(client.calls.some((call) => call.method === "Page.bringToFront"), false);
});

test("requestResumeWithRetry stops after three failed attempts", async () => {
  const client = createRequestResumeFakeClient([
    { resumeState: "索要简历", successMessageCount: 0 },
    { resumeState: "索要简历", successMessageCount: 0 },
    { resumeState: "索要简历", successMessageCount: 0 },
    { resumeState: "索要简历", successMessageCount: 0 },
    { resumeState: "索要简历", successMessageCount: 0 },
    { resumeState: "索要简历", successMessageCount: 0 },
    { resumeState: "索要简历", successMessageCount: 0 },
    { resumeState: "索要简历", successMessageCount: 0 }
  ]);

  const result = await requestResumeWithRetry(client, {
    beforeState: { rowKey: "candidate-1", resumeState: "索要简历" },
    maxAttempts: 3,
    clickSettleMs: 0,
    verifyDelayMs: 0,
    retryDelayMs: 0
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "request_resume_retry_exhausted");
  assert.equal(result.clickedAttempts, 3);
  assert.equal(result.attempts.length, 3);
});

test("summarizeChatScreening reports candidate_limit as target successes", () => {
  const summary = summarizeChatScreening({
    passed: true,
    jobTitle: "全部职位",
    unreadOnly: false,
    requestedCandidateLimit: 2,
    requestResumeSuccesses: 2,
    processedCandidates: 5,
    screenableCandidates: 3,
    skippedRows: 2,
    llmCalls: 3,
    actionClicks: 2,
    stopReason: "candidate_limit_reached",
    violations: []
  });

  assert.equal(summary.targetRequestResumeSuccesses, 2);
  assert.equal(summary.requestResumeSuccesses, 2);
  assert.equal(summary.processedCandidates, 5);
  assert.equal(summary.ok, true);
});

test("resolveChatScreeningScrollStopReason stops when chat list reaches bottom", () => {
  assert.equal(resolveChatScreeningScrollStopReason({
    latestSnapshot: { atBottom: true, maxContactsVisible: false },
    idleScrollPasses: 0
  }), "list_bottom_reached");

  assert.equal(resolveChatScreeningScrollStopReason({
    scroll: { atBottom: true, moved: true, maxContactsVisible: false },
    idleScrollPasses: 0
  }), "list_bottom_reached");
});

test("resolveChatScreeningScrollStopReason keeps terminal signals ahead of bottom and idle", () => {
  assert.equal(resolveChatScreeningScrollStopReason({
    latestSnapshot: { atBottom: true, maxContactsVisible: true },
    idleScrollPasses: 2
  }), "max_contacts_reached");

  assert.equal(resolveChatScreeningScrollStopReason({
    latestSnapshot: { atBottom: false, maxContactsVisible: false },
    scroll: { atBottom: false, maxContactsVisible: false },
    idleScrollPasses: 2
  }), "no_scroll_progress");
});

function createRequestResumeFakeClient(states) {
  let readIndex = 0;
  const calls = [];
  return {
    calls,
    async evaluate(fn, arg) {
      const source = String(fn);
      if (arg?.selector) {
        return {
          x: 10,
          y: 20,
          text: arg.expectedText || "索要简历",
          className: "im-ui-action-button action-item action-resume"
        };
      }
      if (source.includes("确定向对方索要简历吗")) {
        return {
          present: true,
          target: {
            x: 30,
            y: 40,
            text: "确 定",
            className: "ant-im-btn-primary"
          }
        };
      }
      if (source.includes("successMessages")) {
        const next = states[Math.min(readIndex, states.length - 1)];
        readIndex += 1;
        return {
          resumeState: next.resumeState,
          successMessageCount: next.successMessageCount || 0,
          latestSuccessMessage: next.latestSuccessMessage || "",
          allSuccessMessages: []
        };
      }
      throw new Error(`Unexpected evaluate call: ${source.slice(0, 100)}`);
    },
    async waitFor() {
      return true;
    },
    async send(method, params) {
      calls.push({ method, params });
    }
  };
}
