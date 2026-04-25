import assert from "node:assert/strict";
import test from "node:test";

import { buildChatScreenInput } from "./chat-screen-input.js";

test("buildChatScreenInput creates auditable source manifest", () => {
  const input = buildChatScreenInput({
    location: "https://lpt.liepin.com/chat/im",
    row: {
      rowIndex: 3,
      rowKey: "candidate-1",
      rowType: "candidate",
      rowText: "候选人 招聘实习生 你好",
      candidateName: "候选人",
      candidateTitle: "招聘实习生",
      resumeState: "索要简历",
      actionLabels: ["索要手机", "索要微信", "索要简历"]
    },
    candidateHeaderText: "候选人 今天活跃 杭州 22岁 本科 2026年毕业",
    userInfoText: "杭州 22岁 本科 2026年毕业",
    resumeSummaryText: "某公司 · 招聘实习生 某大学 · 人力资源",
    hasRequestResumeButton: true,
    sources: [
      { id: "conversation_row", text: "候选人 招聘实习生 你好" },
      { id: "chat_header", text: "候选人 今天活跃 杭州 22岁 本科 2026年毕业" },
      { id: "header_resume_summary", text: "某公司 · 招聘实习生 某大学 · 人力资源" },
      { id: "message_list", text: "你好，请问考虑工作机会吗？" },
      { id: "action_bar", text: "索要手机 索要微信 索要简历" }
    ]
  });

  assert.equal(input.schemaVersion, "liepin_chat_screen_input_v1");
  assert.equal(input.candidate.name, "候选人");
  assert.equal(input.candidate.title, "招聘实习生");
  assert.equal(input.state.resumeState, "索要简历");
  assert.equal(input.state.hasRequestResumeButton, true);
  assert.equal(input.manifest.missingRequiredSourceIds.length, 0);
  assert.ok(input.manifest.payloadHash);
  assert.ok(input.sources.every((source) => source.hash && source.charCount > 0));
});
