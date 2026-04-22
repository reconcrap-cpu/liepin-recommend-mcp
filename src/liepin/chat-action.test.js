import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_ACTIONS, summarizeChatActionResult } from "./chat-action.js";
import { returnResumeDetailToChatList } from "./chat-sampler.js";

test("summarizeChatActionResult reports none as no-click success", () => {
  const summary = summarizeChatActionResult({
    action: CHAT_ACTIONS.NONE,
    executed: true,
    clicked: false,
    ok: true,
    status: "none_noop",
    before: {
      rowKey: "candidate",
      resumeState: "索要简历"
    },
    after: {
      rowKey: "candidate",
      resumeState: "索要简历"
    }
  });

  assert.deepEqual(summary, {
    action: "none",
    executed: true,
    clicked: false,
    ok: true,
    status: "none_noop",
    beforeState: "索要简历",
    afterState: "索要简历",
    rowKey: "candidate"
  });
});

test("summarizeChatActionResult reports request_resume transition", () => {
  const summary = summarizeChatActionResult({
    action: CHAT_ACTIONS.REQUEST_RESUME,
    executed: true,
    clicked: true,
    confirmation: {
      present: true,
      clicked: true
    },
    ok: true,
    status: "request_resume_clicked",
    before: {
      rowKey: "candidate",
      resumeState: "索要简历"
    },
    after: {
      rowKey: "candidate",
      resumeState: "索要中"
    }
  });

  assert.equal(summary.clicked, true);
  assert.equal(summary.ok, true);
  assert.equal(summary.beforeState, "索要简历");
  assert.equal(summary.afterState, "索要中");
});

test("returnResumeDetailToChatList closes spawned detail page and restores chat target", async () => {
  const calls = [];
  const parentClient = {};
  const resumeClient = {
    async closePage() {
      calls.push("resume.closePage");
    },
    async disconnect() {
      calls.push("resume.disconnect");
    }
  };

  const result = await returnResumeDetailToChatList({
    parentClient,
    resumeClient,
    resumeTarget: { id: "resume-target" },
    knownTargets: [{ id: "chat-target" }]
  });

  assert.deepEqual(calls, [
    "resume.closePage",
    "resume.disconnect"
  ]);
  assert.deepEqual(result, {
    closedChildPage: true,
    returnedToChat: true
  });
});
