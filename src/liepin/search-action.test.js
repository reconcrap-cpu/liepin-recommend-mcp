import test from "node:test";
import assert from "node:assert/strict";

import {
  executeSearchChatAction,
  isAlreadyContactedButtonText,
  isImmediateChatButtonText,
  waitForSearchServiceJobSelection
} from "./search-action.js";
import { searchSelectors } from "./selectors.js";

test("search chat button text helpers distinguish immediate and already-contacted states", () => {
  assert.equal(isImmediateChatButtonText(" 立即沟通 "), true);
  assert.equal(isImmediateChatButtonText("继续沟通"), false);
  assert.equal(isAlreadyContactedButtonText("继续沟通"), true);
  assert.equal(isAlreadyContactedButtonText("立即沟通"), false);
});

test("service job row selector supports the current modal div structure", () => {
  assert.equal(searchSelectors.serviceJobContainer, '[id^="serviceJobListContainer"]');
  assert.equal(searchSelectors.serviceJobRow.includes('> div > div > div'), true);
  assert.equal(searchSelectors.serviceJobRow.includes('[class*="jobListWrap"] li'), true);
});

test("waits for service job options before treating the chat job as missing", async () => {
  const attempts = [
    {
      clicked: false,
      reason: "job_not_found",
      requested: "科研算法工程师",
      availableJobs: ["您暂时没有可用的职位哦~ 去发布职位"]
    },
    {
      clicked: true,
      requested: "科研算法工程师",
      selectedTitle: "科研算法工程师",
      matchType: "exact",
      availableJobs: ["科研算法工程师"]
    }
  ];
  const client = {
    async evaluate() {
      return attempts.shift();
    }
  };

  const selected = await waitForSearchServiceJobSelection(client, "科研算法工程师", {
    timeoutMs: 1000,
    pollMs: 1
  });

  assert.equal(selected.clicked, true);
  assert.equal(selected.selectedTitle, "科研算法工程师");
  assert.equal(selected.attempts, 2);
});

test("accepts direct contacted state when service job modal is skipped", async () => {
  const evaluations = [
    {
      exists: true,
      text: "立即沟通",
      className: "xpath-open-im-btn",
      disabled: false
    },
    {
      clicked: true,
      text: "立即沟通",
      className: "xpath-open-im-btn"
    },
    {
      exists: true,
      text: "继续沟通",
      className: "xpath-open-im-btn",
      disabled: false
    }
  ];
  const client = {
    async evaluate() {
      return evaluations.shift();
    },
    async waitFor() {
      return false;
    }
  };

  const action = await executeSearchChatAction(client, {
    jobTitle: "科研算法工程师"
  });

  assert.equal(action.ok, true);
  assert.equal(action.status, "search_contacted");
  assert.equal(action.selectedJob, null);
  assert.equal(action.after.text, "继续沟通");
});
