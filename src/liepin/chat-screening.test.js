import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyChatCvCollectionState,
  CHAT_CV_REQUEST_DAILY_LIMIT_STATUS,
  CHAT_RUN_MODES,
  DEFAULT_CHAT_REST_LEVEL,
  findNextUnseenChatRowIndex,
  hasChatResumeRequestMessage,
  isChatCvRequestDailyLimitState,
  isChatRequestSuccessState,
  normalizeChatRestLevel,
  requestResumeWithRetry,
  restAfterChatCandidate,
  resolveChatHumanRestPolicy,
  resolveChatScreeningScrollStopReason,
  shouldRequestResumeForDecision,
  summarizeChatScreening
} from "./chat-screening.js";

test("classifyChatCvCollectionState treats pending button or request message as fulfilled", () => {
  assert.deepEqual(classifyChatCvCollectionState({
    rowType: "candidate",
    resumeState: "索要中"
  }), {
    fulfilled: true,
    shouldRequest: false,
    status: "cv_request_already_pending",
    reason: "resume_request_already_pending",
    resumeState: "索要中"
  });

  const byMessage = classifyChatCvCollectionState({
    rowType: "candidate",
    resumeState: "索要简历"
  }, {
    resumeState: "索要简历",
    latestSuccessMessage: "我想要一份你的简历，你是否同意？"
  });
  assert.equal(byMessage.fulfilled, true);
  assert.equal(byMessage.status, "cv_request_already_sent");
  assert.equal(byMessage.reason, "resume_request_message_found");

  const requestable = classifyChatCvCollectionState({
    rowType: "candidate",
    resumeState: "索要简历"
  });
  assert.equal(requestable.fulfilled, false);
  assert.equal(requestable.shouldRequest, true);

  const available = classifyChatCvCollectionState({
    rowType: "candidate",
    resumeState: "看简历"
  });
  assert.equal(available.fulfilled, true);
  assert.equal(available.status, "cv_already_available");
});

test("hasChatResumeRequestMessage detects request-message evidence", () => {
  assert.equal(hasChatResumeRequestMessage({ successMessageCount: 1 }), true);
  assert.equal(hasChatResumeRequestMessage({ latestSuccessMessage: "我想要一份你的简历" }), true);
  assert.equal(hasChatResumeRequestMessage({ allSuccessMessages: ["我想要一份你的简历"] }), true);
  assert.equal(hasChatResumeRequestMessage({ successMessageCount: 0 }), false);
});

test("isChatCvRequestDailyLimitState detects daily request quota toast", () => {
  assert.equal(isChatCvRequestDailyLimitState({
    toastTexts: ["今日索要已达上限"],
    latestToastText: "今日索要已达上限"
  }), true);
  assert.equal(isChatCvRequestDailyLimitState({
    bodyTextTail: "其他提示 索要已达上限"
  }), true);
  assert.equal(isChatCvRequestDailyLimitState({
    toastTexts: ["索要简历成功"]
  }), false);
});

test("chat rest policy defaults to aggressive high and accepts Boss-compatible inputs", () => {
  assert.equal(DEFAULT_CHAT_REST_LEVEL, "high");
  assert.equal(normalizeChatRestLevel("aggressive"), "high");
  assert.equal(resolveChatHumanRestPolicy().restLevel, "high");
  assert.deepEqual(resolveChatHumanRestPolicy({
    human_behavior: { restLevel: "medium" }
  }).restLevel, "medium");
  assert.equal(resolveChatHumanRestPolicy({}, {
    SOURCING_BOSS_CHAT_REST_LEVEL: "low"
  }).restLevel, "low");
  assert.equal(resolveChatHumanRestPolicy({ rest_level: "off" }).enabled, false);
});

test("restAfterChatCandidate rests only for collect-CV candidate rows", async () => {
  const policy = {
    enabled: true,
    restLevel: "high",
    collectCvPerCandidateRestMinMs: 5,
    collectCvPerCandidateRestMaxMs: 5
  };
  const skipped = await restAfterChatCandidate({
    collectCvMode: true,
    humanRest: policy,
    state: { rowType: "system", rowIndex: 0 },
    sleepFn: () => {
      throw new Error("system rows should not rest");
    }
  });
  assert.equal(skipped.rested, false);

  const sleeps = [];
  const progress = [];
  const rested = await restAfterChatCandidate({
    collectCvMode: true,
    humanRest: policy,
    state: {
      rowType: "candidate",
      rowIndex: 2,
      rowKey: "candidate-2",
      resumeState: "索要简历"
    },
    counters: {
      processedCandidates: 2,
      humanRestCount: 3,
      humanRestMs: 40
    },
    emitProgress: (stage, status, payload) => progress.push({ stage, status, payload }),
    sleepFn: async (ms) => sleeps.push(ms)
  });

  assert.equal(rested.rested, true);
  assert.equal(rested.restMs, 5);
  assert.deepEqual(sleeps, [5]);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].stage, "human_rest");
  assert.equal(progress[0].payload.humanRestCount, 4);
  assert.equal(progress[0].payload.humanRestMs, 45);
  assert.equal(progress[0].payload.currentRowKey, "candidate-2");
});

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

test("requestResumeWithRetry stops immediately on daily request quota", async () => {
  const client = createRequestResumeFakeClient([
    { resumeState: "索要简历", successMessageCount: 0 },
    { resumeState: "索要简历", successMessageCount: 0 },
    {
      resumeState: "索要简历",
      successMessageCount: 0,
      toastTexts: ["今日索要已达上限"],
      latestToastText: "今日索要已达上限"
    }
  ]);

  const result = await requestResumeWithRetry(client, {
    beforeState: { rowKey: "candidate-1", resumeState: "索要简历" },
    maxAttempts: 3,
    clickSettleMs: 0,
    verifyDelayMs: 0,
    retryDelayMs: 0
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, CHAT_CV_REQUEST_DAILY_LIMIT_STATUS);
  assert.equal(result.quotaExhausted, true);
  assert.equal(result.dailyLimitReached, true);
  assert.equal(result.clickedAttempts, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].status, CHAT_CV_REQUEST_DAILY_LIMIT_STATUS);
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

test("summarizeChatScreening reports all-candidates target as null", () => {
  const summary = summarizeChatScreening({
    passed: true,
    jobTitle: "全部职位",
    unreadOnly: true,
    requestedCandidateLimit: null,
    scanAllCandidates: true,
    requestResumeSuccesses: 3,
    processedCandidates: 8,
    screenableCandidates: 4,
    skippedRows: 4,
    llmCalls: 4,
    actionClicks: 3,
    stopReason: "list_bottom_reached",
    violations: []
  });

  assert.equal(summary.targetRequestResumeSuccesses, null);
  assert.equal(summary.requestResumeSuccesses, 3);
  assert.equal(summary.ok, true);
});

test("summarizeChatScreening reports collect-CV counters", () => {
  const summary = summarizeChatScreening({
    passed: true,
    mode: CHAT_RUN_MODES.COLLECT_CV,
    jobTitle: "全部职位",
    unreadOnly: false,
    requestedCandidateLimit: 3,
    requestResumeSuccesses: 1,
    cvCollectionFulfillments: 3,
    alreadyRequestedCvCount: 1,
    alreadyAvailableCvCount: 1,
    processedCandidates: 4,
    screenableCandidates: 0,
    skippedRows: 1,
    llmCalls: 0,
    actionClicks: 1,
    stopReason: "candidate_limit_reached",
    violations: []
  });

  assert.equal(summary.mode, "collect_cv");
  assert.equal(summary.targetRequestResumeSuccesses, null);
  assert.equal(summary.targetCvCollectionFulfillments, 3);
  assert.equal(summary.cvCollectionFulfillments, 3);
  assert.equal(summary.requestResumeSuccesses, 1);
  assert.equal(summary.alreadyRequestedCvCount, 1);
  assert.equal(summary.alreadyAvailableCvCount, 1);
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
    idleScrollPasses: 2,
    noNewRowsPasses: 2
  }), "max_contacts_reached");

  assert.equal(resolveChatScreeningScrollStopReason({
    latestSnapshot: { atBottom: false, maxContactsVisible: false },
    scroll: { atBottom: false, maxContactsVisible: false },
    idleScrollPasses: 2,
    noNewRowsPasses: 2
  }), "no_scroll_progress");
});

test("resolveChatScreeningScrollStopReason stops after repeated full passes with no new rows", () => {
  assert.equal(resolveChatScreeningScrollStopReason({
    latestSnapshot: { atBottom: false, maxContactsVisible: false },
    scroll: { atBottom: false, moved: true, maxContactsVisible: false },
    idleScrollPasses: 0,
    noNewRowsPasses: 1
  }), "");

  assert.equal(resolveChatScreeningScrollStopReason({
    latestSnapshot: { atBottom: false, maxContactsVisible: false },
    scroll: { atBottom: false, moved: true, maxContactsVisible: false },
    idleScrollPasses: 0,
    noNewRowsPasses: 2
  }), "no_new_rows_after_full_pass");
});

test("findNextUnseenChatRowIndex skips seen rows before activation", () => {
  const seenRows = new Set(["row-0", "row-1", "row-2"]);
  assert.equal(findNextUnseenChatRowIndex({
    rows: [
      { index: 0, rowKey: "row-0" },
      { index: 1, rowKey: "row-1" },
      { index: 2, rowKey: "row-2" },
      { index: 3, rowKey: "row-3" }
    ]
  }, seenRows), 3);
  assert.equal(findNextUnseenChatRowIndex({
    rows: [
      { index: 0, rowKey: "row-0" },
      { index: 1, rowKey: "row-1" }
    ]
  }, seenRows), 2);
  assert.equal(findNextUnseenChatRowIndex({
    rows: [
      { index: 0, rowKey: "row-0" },
      { index: 1, rowKey: "new-top-row" },
      { index: 2, rowKey: "row-2" },
      { index: 3, rowKey: "row-3" }
    ]
  }, seenRows, { minimumIndex: 3 }), 3);
  assert.equal(findNextUnseenChatRowIndex({}, seenRows), 0);
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
          allSuccessMessages: [],
          toastTexts: next.toastTexts || [],
          latestToastText: next.latestToastText || "",
          bodyTextTail: next.bodyTextTail || ""
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
