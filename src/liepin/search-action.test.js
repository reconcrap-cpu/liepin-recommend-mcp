import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMUNICATION_QUOTA_EXHAUSTED_STATUS,
  isChatCardLimitModalText
} from "./chat-card-limit.js";
import {
  closeSentGreetingUpsellModal,
  isSentGreetingUpsellModalText
} from "./sent-greeting-upsell.js";
import {
  closeSearchModalToList,
  executeSearchChatAction,
  isAlreadyContactedButtonText,
  isImmediateChatButtonText,
  isSearchHideReadStateVerified,
  waitForSearchServiceJobSelection
} from "./search-action.js";
import { searchSelectors } from "./selectors.js";

test("search chat button text helpers distinguish immediate and already-contacted states", () => {
  assert.equal(isImmediateChatButtonText(" 立即沟通 "), true);
  assert.equal(isImmediateChatButtonText("继续沟通"), false);
  assert.equal(isAlreadyContactedButtonText("继续沟通"), true);
  assert.equal(isAlreadyContactedButtonText("立即沟通"), false);
});

test("chat card limit modal text is recognized as communication quota exhausted", () => {
  assert.equal(isChatCardLimitModalText("购买开聊卡 资源不足 猎币支付"), true);
  assert.equal(isChatCardLimitModalText("请选择开聊职位 确认"), false);
});

test("sent greeting upsell modal text is recognized as benign close-and-continue modal", () => {
  assert.equal(isSentGreetingUpsellModalText("已向候选人发送消息 更快获取人选回复 免费发起 关闭"), true);
  assert.equal(isSentGreetingUpsellModalText("已向候选人发送消息 购买开聊卡 资源不足"), false);
});

test("service job row selector supports the current modal div structure", () => {
  assert.equal(searchSelectors.serviceJobContainer, '[id^="serviceJobListContainer"]');
  assert.equal(searchSelectors.serviceJobRow.includes('> div > div > div'), true);
  assert.equal(searchSelectors.serviceJobRow.includes('[class*="jobListWrap"] li'), true);
});

test("search hide-read checkbox verification matches Liepin checked DOM", () => {
  assert.equal(searchSelectors.hideReadCheckboxInput, 'input[name="filterRead"].ant-lpt-checkbox-input');
  assert.equal(isSearchHideReadStateVerified({
    found: true,
    checked: true,
    value: "1",
    className: "ant-lpt-checkbox ant-lpt-checkbox-checked"
  }, true), true);
  assert.equal(isSearchHideReadStateVerified({
    found: true,
    checked: false,
    value: "",
    className: "ant-lpt-checkbox"
  }, false), true);
  assert.equal(isSearchHideReadStateVerified({
    found: true,
    checked: true,
    value: "1",
    className: "ant-lpt-checkbox ant-lpt-checkbox-checked"
  }, false), false);
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
      type: "pending",
      buttonState: {
        exists: true,
        text: "继续沟通",
        className: "xpath-open-im-btn",
        disabled: false
      }
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

test("returns quota exhausted when buy chat card modal appears after immediate chat click", async () => {
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
      type: "chat_card_limit",
      chatCardLimitModal: {
        present: true,
        status: COMMUNICATION_QUOTA_EXHAUSTED_STATUS,
        reason: "buy_chat_card_modal",
        modalText: "购买开聊卡 资源不足 猎币支付"
      }
    }
  ];
  const client = {
    async evaluate() {
      return evaluations.shift();
    }
  };

  const action = await executeSearchChatAction(client, {
    jobTitle: "科研算法工程师"
  });

  assert.equal(action.ok, false);
  assert.equal(action.status, COMMUNICATION_QUOTA_EXHAUSTED_STATUS);
  assert.equal(action.quotaExhausted, true);
  assert.equal(action.clicked, true);
});

test("closes sent greeting upsell after search greeting and counts the greeting", async () => {
  const modalText = "已向候选人发送消息 更快获取人选回复 试试新权益 超级聊聊权益 免费发起 关闭";
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
      type: "sent_greeting_upsell",
      sentGreetingUpsellModal: {
        present: true,
        status: "sent_greeting_upsell_modal",
        reason: "sent_greeting_upsell_modal",
        modalText
      }
    },
    {
      present: true,
      status: "sent_greeting_upsell_modal",
      reason: "sent_greeting_upsell_modal",
      modalText
    },
    {
      clicked: true,
      text: "关闭",
      closeMethod: "button_text"
    },
    {
      present: false,
      status: "",
      reason: "sent_greeting_upsell_modal_not_found"
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
      if (evaluations.length === 0) throw new Error("Unexpected evaluate call");
      return evaluations.shift();
    }
  };

  const action = await executeSearchChatAction(client, {
    jobTitle: "科研算法工程师"
  });

  assert.equal(action.ok, true);
  assert.equal(action.status, "search_contacted");
  assert.equal(action.clicked, true);
  assert.equal(action.modalClosed, true);
  assert.equal(action.sentGreetingUpsellModal.clicked, true);
  assert.equal(evaluations.length, 0);
});

test("closeSearchModalToList closes a standalone sent greeting upsell", async () => {
  const modalText = "已向候选人发送消息 更快获取人选回复 免费发起 关闭";
  const evaluations = [
    {
      clicked: false,
      reason: "modal_not_open"
    },
    {
      present: true,
      status: "sent_greeting_upsell_modal",
      reason: "sent_greeting_upsell_modal",
      modalText
    },
    {
      clicked: true,
      text: "关闭",
      closeMethod: "button_text"
    },
    {
      present: false,
      status: "",
      reason: "sent_greeting_upsell_modal_not_found"
    },
    false,
    {
      restored: true,
      removedRootCount: 0,
      bodyOverflowY: "auto"
    }
  ];
  const client = {
    async evaluate() {
      if (evaluations.length === 0) throw new Error("Unexpected evaluate call");
      return evaluations.shift();
    }
  };

  const closeAction = await closeSearchModalToList(client);

  assert.equal(closeAction.closed, true);
  assert.equal(closeAction.closeMethod, "sent_greeting_upsell");
  assert.equal(closeAction.sentGreetingUpsellModal.clicked, true);
  assert.equal(evaluations.length, 0);
});

test("closeSearchModalToList ignores residual wrappers without printable resume content", async () => {
  const evaluations = [
    {
      clicked: false,
      reason: "modal_not_open"
    },
    {
      present: false,
      status: "",
      reason: "sent_greeting_upsell_modal_not_found"
    },
    false,
    {
      present: false,
      status: "",
      reason: "sent_greeting_upsell_modal_not_found"
    },
    {
      restored: true,
      removedRootCount: 1,
      bodyOverflowY: "auto"
    }
  ];
  const client = {
    async evaluate() {
      if (evaluations.length === 0) throw new Error("Unexpected evaluate call");
      return evaluations.shift();
    }
  };

  const closeAction = await closeSearchModalToList(client);

  assert.equal(closeAction.closed, true);
  assert.equal(closeAction.closeMethod, "already_closed");
  assert.equal(closeAction.sentGreetingUpsellModal, null);
  assert.equal(closeAction.listScrollRestore.removedRootCount, 1);
  assert.equal(evaluations.length, 0);
});

test("closeSearchModalToList waits for delayed upsell after closing resume modal", async () => {
  const modalText = "已向候选人发送消息 加急通道触达 免费发起 关闭";
  const evaluations = [
    {
      clicked: false,
      reason: "modal_not_open"
    },
    {
      present: false,
      status: "",
      reason: "sent_greeting_upsell_modal_not_found"
    },
    true,
    {
      clicked: true,
      className: "ant-lpt-modal-close"
    },
    {
      present: false,
      status: "",
      reason: "sent_greeting_upsell_modal_not_found"
    },
    {
      present: true,
      status: "sent_greeting_upsell_modal",
      reason: "sent_greeting_upsell_modal",
      modalText
    },
    {
      present: true,
      status: "sent_greeting_upsell_modal",
      reason: "sent_greeting_upsell_modal",
      modalText
    },
    {
      clicked: true,
      text: "关闭",
      closeMethod: "button_text"
    },
    {
      present: false,
      status: "",
      reason: "sent_greeting_upsell_modal_not_found"
    },
    {
      restored: true,
      removedRootCount: 0,
      bodyOverflowY: "auto"
    }
  ];
  const client = {
    async evaluate() {
      if (evaluations.length === 0) throw new Error("Unexpected evaluate call");
      return evaluations.shift();
    },
    async waitFor() {
      return true;
    }
  };

  const closeAction = await closeSearchModalToList(client, {
    waitForSentGreetingUpsellMs: 5
  });

  assert.equal(closeAction.closed, true);
  assert.equal(closeAction.resumeModalClosed, true);
  assert.equal(closeAction.sentGreetingUpsellModal.clicked, true);
  assert.equal(evaluations.length, 0);
});

test("closeSearchModalToList falls back to real mouse close when DOM click is ignored", async () => {
  const evaluations = [
    {
      clicked: false,
      reason: "modal_not_open"
    },
    {
      present: false,
      status: "",
      reason: "sent_greeting_upsell_modal_not_found"
    },
    true,
    {
      clicked: true,
      className: "closeBtn--I_u6B",
      target: { x: 1178, y: 27 }
    },
    {
      present: false,
      status: "",
      reason: "sent_greeting_upsell_modal_not_found"
    },
    {
      restored: true,
      removedRootCount: 0,
      bodyOverflowY: "auto"
    }
  ];
  const waitResults = [false, true];
  const sent = [];
  const client = {
    async evaluate() {
      if (evaluations.length === 0) throw new Error("Unexpected evaluate call");
      return evaluations.shift();
    },
    async waitFor() {
      if (waitResults.length === 0) throw new Error("Unexpected waitFor call");
      return waitResults.shift();
    },
    async send(method, params) {
      sent.push({ method, params });
    }
  };

  const closeAction = await closeSearchModalToList(client);

  assert.equal(closeAction.closed, true);
  assert.equal(closeAction.resumeModalClosed, true);
  assert.equal(closeAction.closeMethod, "close_button+mouse");
  assert.deepEqual(sent.map((item) => item.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(evaluations.length, 0);
});

test("closeSearchModalToList force-removes a stuck search detail modal after close fallbacks", async () => {
  const evaluations = [
    {
      clicked: false,
      reason: "modal_not_open"
    },
    {
      present: false,
      status: "",
      reason: "sent_greeting_upsell_modal_not_found"
    },
    true,
    {
      clicked: true,
      className: "closeBtn--I_u6B",
      target: { x: 1178, y: 27 }
    },
    {
      removed: true,
      removedCount: 1,
      removedNodes: [{ className: "resume-detail-modal-wrap", textLength: 1000 }]
    },
    {
      present: false,
      status: "",
      reason: "sent_greeting_upsell_modal_not_found"
    },
    {
      restored: true,
      previousUrl: "https://lpt.liepin.com/search#preview",
      currentUrl: "https://lpt.liepin.com/search",
      removedRootCount: 1,
      bodyOverflowY: "auto",
      htmlOverflowY: "visible",
      htmlScrollHeight: 3968,
      bodyScrollHeight: 3968
    }
  ];
  const waitResults = [false, false, false, true];
  const sent = [];
  const client = {
    async evaluate() {
      if (evaluations.length === 0) throw new Error("Unexpected evaluate call");
      return evaluations.shift();
    },
    async waitFor() {
      if (waitResults.length === 0) throw new Error("Unexpected waitFor call");
      return waitResults.shift();
    },
    async send(method, params) {
      sent.push({ method, params });
    }
  };

  const closeAction = await closeSearchModalToList(client);

  assert.equal(closeAction.closed, true);
  assert.equal(closeAction.resumeModalClosed, true);
  assert.equal(closeAction.closeMethod, "close_button+escape+force_remove");
  assert.equal(closeAction.forceDismiss.removed, true);
  assert.equal(closeAction.listScrollRestore.currentUrl, "https://lpt.liepin.com/search");
  assert.equal(closeAction.listScrollRestore.bodyOverflowY, "auto");
  assert.deepEqual(sent.map((item) => item.method), [
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.dispatchKeyEvent"
  ]);
  assert.equal(evaluations.length, 0);
});

test("closeSentGreetingUpsellModal force-removes stuck leave animation modal", async () => {
  const modalText = "已向候选人发送消息 加急通道触达 免费发起 关闭";
  const evaluations = [
    {
      present: true,
      status: "sent_greeting_upsell_modal",
      reason: "sent_greeting_upsell_modal",
      modalText
    },
    {
      clicked: true,
      text: "关闭",
      closeMethod: "button_text"
    },
    {
      present: true,
      status: "sent_greeting_upsell_modal",
      reason: "sent_greeting_upsell_modal",
      modalText
    },
    {
      removed: true,
      reason: "sent_greeting_upsell_force_removed",
      removedCount: 2
    },
    {
      present: false,
      status: "",
      reason: "sent_greeting_upsell_modal_not_found"
    }
  ];
  const client = {
    async evaluate() {
      if (evaluations.length === 0) throw new Error("Unexpected evaluate call");
      return evaluations.shift();
    }
  };

  const closeAction = await closeSentGreetingUpsellModal(client, {
    timeoutMs: 0,
    pollMs: 1
  });

  assert.equal(closeAction.closed, true);
  assert.equal(closeAction.closeMethod, "button_text+force_remove");
  assert.equal(closeAction.forceDismiss.removed, true);
  assert.equal(evaluations.length, 0);
});
