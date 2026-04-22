import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatPageRowState,
  buildChatPageScreenInput,
  buildRecommendBasicChatRowState,
  buildRecommendBasicChatScreenInput,
  evaluateRecommendChatChain,
  inferRecommendBasicChatResumeState,
  summarizeRecommendChatChain
} from "./recommend-chat-chain.js";

test("inferRecommendBasicChatResumeState recognizes P14 chat states from same-page modal", () => {
  assert.equal(inferRecommendBasicChatResumeState({
    actionBarText: "索要简历 跳转沟通页",
    hasRequestResumeButton: true
  }), "索要简历");
  assert.equal(inferRecommendBasicChatResumeState({
    actionBarText: "已向对方索要"
  }), "索要中");
  assert.equal(inferRecommendBasicChatResumeState({
    actionBarText: "看简历"
  }), "看简历");
});

test("buildRecommendBasicChatScreenInput keeps required chat source manifest", () => {
  const candidate = {
    name: "张三",
    resumeId: "resume-1",
    label: "张三 3年经验"
  };
  const chatEntry = {
    url: "https://lpt.liepin.com/recommend",
    headerName: "张三",
    headerBasicInfo: "24岁 本科 3年经验",
    headerUserInfo: "当前在线",
    messageListText: "您好，我对职位很感兴趣。",
    actionBarText: "索要简历 跳转沟通页",
    hasRequestResumeButton: true
  };

  const state = buildRecommendBasicChatRowState({ candidate, chatEntry });
  const input = buildRecommendBasicChatScreenInput({ candidate, chatEntry, chatState: state });

  assert.equal(state.rowType, "candidate");
  assert.equal(state.resumeState, "索要简历");
  assert.equal(input.state.hasRequestResumeButton, true);
  assert.deepEqual(input.manifest.missingRequiredSourceIds, []);
});

test("buildChatPageScreenInput keeps required chat source manifest", () => {
  const candidate = {
    name: "李四",
    resumeId: "resume-2",
    label: "李四 1年经验"
  };
  const chatEntry = {
    url: "https://lpt.liepin.com/chat/im",
    headerText: "李四 在线 杭州 24岁 本科",
    headerBasicInfo: "李四 在线 杭州 24岁 本科",
    headerUserInfo: "在职，看看机会",
    resumeSummaryText: "运营专员 本科",
    activeRowText: "李四 招聘实习生",
    messageListText: "您好，我想了解一下岗位情况。",
    actionBarText: "索要手机 索要微信 索要简历 约面试",
    hasRequestResumeButton: true,
    activeRowState: {
      rowIndex: 2,
      rowKey: "row-2",
      rowType: "candidate",
      rowText: "李四 招聘实习生",
      resumeState: "索要简历",
      actionLabels: ["索要简历"]
    }
  };

  const state = buildChatPageRowState({ candidate, chatEntry });
  const input = buildChatPageScreenInput({ candidate, chatEntry, chatState: state });

  assert.equal(state.rowType, "candidate");
  assert.equal(state.resumeState, "索要简历");
  assert.equal(input.state.hasRequestResumeButton, true);
  assert.deepEqual(input.manifest.missingRequiredSourceIds, []);
});

test("evaluateRecommendChatChain rejects resume requests from non-screenable chat states", () => {
  const evaluation = evaluateRecommendChatChain({
    requestedCandidateLimit: 1,
    chainedCandidates: 1,
    samePageChatEntries: 1,
    executeRequestResume: true,
    requestResumeClicks: 1,
    violations: [],
    items: [
      {
        index: 0,
        recommendLlmCalled: true,
        recommendDecision: { decision: "pass", post_action: "chat" },
        recommendChatAction: { clicked: true },
        chatVerification: { verified: true, entryKind: "recommend_basic_chat_modal" },
        chatState: { resumeState: "索要中" },
        chatEligibility: { shouldCallLlm: false },
        chatLlmCalled: false,
        chatAction: { action: "request_resume", clicked: true }
      }
    ]
  });

  assert.equal(evaluation.passed, false);
  assert.ok(evaluation.failures.includes("candidate_0_request_resume_clicked_from_non_screenable_state"));
});

test("summarizeRecommendChatChain reports P22 chain counters", () => {
  const summary = summarizeRecommendChatChain({
    passed: true,
    requestedCandidateLimit: 5,
    scannedCandidates: 6,
    chainedCandidates: 5,
    samePageChatEntries: 5,
    chatPageEntries: 0,
    screenableChatEntries: 4,
    skippedChatEntries: 1,
    recommendLlmCalls: 6,
    chatLlmCalls: 4,
    recommendChatClicks: 5,
    requestResumeClicks: 0,
    actionClicks: 5,
    executeRequestResume: false,
    violations: [],
    items: []
  });

  assert.deepEqual(summary, {
    ok: true,
    requestedCandidateLimit: 5,
    scannedCandidates: 6,
    chainedCandidates: 5,
    samePageChatEntries: 5,
    chatPageEntries: 0,
    screenableChatEntries: 4,
    skippedChatEntries: 1,
    recommendLlmCalls: 6,
    chatLlmCalls: 4,
    recommendChatClicks: 5,
    requestResumeClicks: 0,
    actionClicks: 5,
    executeRequestResume: false,
    violations: []
  });
});

test("evaluateRecommendChatChain accepts verified chat_page entry kind", () => {
  const evaluation = evaluateRecommendChatChain({
    requestedCandidateLimit: 1,
    chainedCandidates: 1,
    samePageChatEntries: 0,
    chatPageEntries: 1,
    executeRequestResume: true,
    requestResumeClicks: 1,
    violations: [],
    items: [
      {
        index: 0,
        recommendLlmCalled: true,
        recommendDecision: { decision: "pass", post_action: "chat" },
        recommendChatAction: { clicked: true },
        chatVerification: { verified: true, entryKind: "chat_page" },
        chatState: { resumeState: "索要简历" },
        chatEligibility: { shouldCallLlm: true },
        chatLlmCalled: true,
        chatAction: { action: "request_resume", clicked: true }
      }
    ]
  });

  assert.equal(evaluation.passed, true);
  assert.deepEqual(evaluation.failures, []);
});
