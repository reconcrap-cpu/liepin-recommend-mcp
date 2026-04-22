import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateRecommendAction,
  extractRecommendCandidateIdentity,
  summarizeRecommendActionResult
} from "./recommend-action.js";
import {
  clearRecommendBlockingOverlaysToList,
  closeRecommendModalToList
} from "./recommend-return.js";

test("extractRecommendCandidateIdentity reads name after 查看大图 and resume id", () => {
  const identity = extractRecommendCandidateIdentity({
    candidateLabel: "推荐职位：",
    textHash: "hash",
    structureSignature: "structure",
    fullText: [
      "推荐职位：",
      "招聘实习生",
      "查看大图",
      "张三",
      "今天活跃",
      "简历编号",
      ": abc123DEF"
    ].join("\n")
  });

  assert.deepEqual(identity, {
    name: "张三",
    resumeId: "abc123DEF",
    label: "推荐职位：",
    textHash: "hash",
    structureSignature: "structure"
  });
});

test("evaluateRecommendAction accepts safe none action", () => {
  const result = {
    action: "none",
    actionExecuted: false,
    actionClicks: 0,
    modalStableAfterNone: true,
    closeAction: { closed: true },
    violations: []
  };

  assert.deepEqual(evaluateRecommendAction(result), {
    ok: true,
    violations: []
  });
});

test("summarizeRecommendActionResult reports verified chat action", () => {
  const summary = summarizeRecommendActionResult({
    ok: true,
    action: "chat",
    actionExecuted: true,
    actionClicks: 1,
    returnToRecommend: true,
    returnToRecommendResult: { ok: true },
    candidate: { name: "李四" },
    chatVerification: {
      verified: true,
      entryKind: "recommend_basic_chat_modal",
      candidateNameMatched: true
    },
    violations: []
  });

  assert.deepEqual(summary, {
    ok: true,
    action: "chat",
    actionExecuted: true,
    actionClicks: 1,
    candidateName: "李四",
    chatVerified: true,
    chatEntryKind: "recommend_basic_chat_modal",
    candidateNameMatched: true,
    hasRequestResumeButton: false,
    returnedToRecommend: true,
    closeVerified: null,
    violations: []
  });
});

test("closeRecommendModalToList closes recommend modal by button without reload", async () => {
  const client = createFakeRecommendReturnClient({
    evaluateResults: [
      {
        url: "https://lpt.liepin.com/recommend",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: true,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: true,
        blockingKinds: ["recommend_modal"]
      },
      {
        clickedAny: true,
        clickedKinds: ["recommend_modal"]
      }
    ],
    waitForResults: [
      {
        url: "https://lpt.liepin.com/recommend",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: false,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: false,
        blockingKinds: []
      }
    ]
  });

  const result = await closeRecommendModalToList(client);

  assert.equal(result.closed, true);
  assert.equal(result.closeMethod, "button");
  assert.deepEqual(client.sendCalls, []);
});

test("closeRecommendModalToList clears stale preview route after button close", async () => {
  const client = createFakeRecommendReturnClient({
    evaluateResults: [
      {
        url: "https://lpt.liepin.com/recommend#preview",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: true,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: true,
        blockingKinds: ["recommend_modal"]
      },
      {
        clickedAny: true,
        clickedKinds: ["recommend_modal"]
      },
      "https://lpt.liepin.com/recommend#preview",
      true
    ],
    waitForResults: [
      {
        url: "https://lpt.liepin.com/recommend#preview",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: false,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: false,
        blockingKinds: []
      },
      {
        url: "https://lpt.liepin.com/recommend",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: false,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: false,
        blockingKinds: []
      }
    ]
  });

  const result = await closeRecommendModalToList(client);

  assert.equal(result.closed, true);
  assert.equal(result.after.url, "https://lpt.liepin.com/recommend");
  assert.equal(result.closeMethod, "button+history_back_cleanup");
  assert.deepEqual(client.sendCalls, []);
});

test("closeRecommendModalToList falls back to Escape without reload or navigation", async () => {
  const client = createFakeRecommendReturnClient({
    evaluateResults: [
      {
        url: "https://lpt.liepin.com/recommend",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: true,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: true,
        blockingKinds: ["recommend_modal"]
      },
      {
        clickedAny: false,
        clickedKinds: []
      },
      []
    ],
    waitForResults: [
      null,
      null,
      {
        url: "https://lpt.liepin.com/recommend",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: false,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: false,
        blockingKinds: []
      }
    ]
  });

  const result = await closeRecommendModalToList(client);

  assert.equal(result.closed, true);
  assert.equal(result.closeMethod, "escape");
  assert.deepEqual(client.sendCalls.map((call) => call.method), [
    "Input.dispatchKeyEvent",
    "Input.dispatchKeyEvent"
  ]);
});

test("closeRecommendModalToList can fall back to real mouse click on close control", async () => {
  const client = createFakeRecommendReturnClient({
    evaluateResults: [
      {
        url: "https://lpt.liepin.com/recommend#preview",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: true,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: true,
        blockingKinds: ["recommend_modal"]
      },
      {
        clickedAny: false,
        clickedKinds: []
      },
      [
        {
          kind: "recommend_modal",
          x: 300,
          y: 200
        }
      ]
    ],
    waitForResults: [
      null,
      {
        url: "https://lpt.liepin.com/recommend",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: false,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: false,
        blockingKinds: []
      }
    ]
  });

  const result = await closeRecommendModalToList(client);

  assert.equal(result.closed, true);
  assert.equal(result.closeMethod, "mouse");
  assert.deepEqual(client.sendCalls.map((call) => call.method), [
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent"
  ]);
});

test("closeRecommendModalToList can fall back to preview route history back without reload", async () => {
  const client = createFakeRecommendReturnClient({
    evaluateResults: [
      {
        url: "https://lpt.liepin.com/recommend#preview",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: true,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: true,
        blockingKinds: ["recommend_modal"]
      },
      {
        clickedAny: false,
        clickedKinds: []
      },
      [],
      "https://lpt.liepin.com/recommend#preview",
      true
    ],
    waitForResults: [
      null,
      null,
      null,
      {
        url: "https://lpt.liepin.com/recommend",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: false,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: false,
        blockingKinds: []
      }
    ]
  });

  const result = await closeRecommendModalToList(client);

  assert.equal(result.closed, true);
  assert.equal(result.closeMethod, "escape+history_back_modal_close");
  assert.deepEqual(client.sendCalls.map((call) => call.method), [
    "Input.dispatchKeyEvent",
    "Input.dispatchKeyEvent"
  ]);
  assert.equal(
    client.evaluateCalls.some((call) => String(call).includes("history.back")),
    true
  );
});

test("closeRecommendModalToList restores preview route if history back leaves modal mounted", async () => {
  const client = createFakeRecommendReturnClient({
    evaluateResults: [
      {
        url: "https://lpt.liepin.com/recommend#preview",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: true,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: true,
        blockingKinds: ["recommend_modal"]
      },
      {
        clickedAny: false,
        clickedKinds: []
      },
      [],
      "https://lpt.liepin.com/recommend#preview",
      true,
      {
        url: "https://lpt.liepin.com/recommend",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: true,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: true,
        blockingKinds: ["recommend_modal"]
      },
      true,
      {
        url: "https://lpt.liepin.com/recommend#preview",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: true,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: true,
        blockingKinds: ["recommend_modal"]
      }
    ],
    waitForResults: [
      null,
      null,
      null,
      null
    ]
  });

  const result = await closeRecommendModalToList(client, {
    maxAttempts: 1,
    timeoutMs: 1000
  });

  assert.equal(result.closed, false);
  assert.equal(result.after.url, "https://lpt.liepin.com/recommend#preview");
  assert.equal(
    client.evaluateCalls.some((call) => String(call).includes("history.forward")),
    true
  );
});

test("clearRecommendBlockingOverlaysToList reports already_list when nothing is open", async () => {
  const client = createFakeRecommendReturnClient({
    evaluateResults: [
      {
        url: "https://lpt.liepin.com/recommend",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: false,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: false,
        blockingKinds: []
      }
    ]
  });

  const result = await clearRecommendBlockingOverlaysToList(client);

  assert.equal(result.closed, true);
  assert.equal(result.closeMethod, "already_list");
  assert.deepEqual(client.sendCalls, []);
});

test("clearRecommendBlockingOverlaysToList clears stale preview hash without touching list filters", async () => {
  const client = createFakeRecommendReturnClient({
    evaluateResults: [
      {
        url: "https://lpt.liepin.com/recommend#preview",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: false,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: false,
        blockingKinds: []
      },
      "https://lpt.liepin.com/recommend#preview",
      true
    ],
    waitForResults: [
      {
        url: "https://lpt.liepin.com/recommend",
        cardCount: 20,
        listReady: true,
        hasRecommendModal: false,
        hasDrawer: false,
        hasImModal: false,
        hasBlockingOverlay: false,
        blockingKinds: []
      }
    ]
  });

  const result = await clearRecommendBlockingOverlaysToList(client);

  assert.equal(result.closed, true);
  assert.equal(result.closeMethod, "history_back_cleanup");
  assert.deepEqual(client.sendCalls, []);
});

function createFakeRecommendReturnClient({
  evaluateResults = [],
  waitForResults = []
} = {}) {
  const evaluateQueue = [...evaluateResults];
  const waitForQueue = [...waitForResults];
  return {
    evaluateCalls: [],
    sendCalls: [],
    async evaluate(expressionOrFunction) {
      this.evaluateCalls.push(expressionOrFunction);
      if (evaluateQueue.length === 0) {
        throw new Error("Unexpected evaluate call");
      }
      return evaluateQueue.shift();
    },
    async waitFor() {
      if (waitForQueue.length === 0) {
        throw new Error("Unexpected waitFor call");
      }
      return waitForQueue.shift();
    },
    async send(method, params) {
      this.sendCalls.push({ method, params });
      return {};
    }
  };
}
