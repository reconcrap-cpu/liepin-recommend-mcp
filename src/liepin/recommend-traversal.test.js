import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateRecommendTraversal,
  summarizeRecommendTraversal
} from "./recommend-traversal.js";

test("evaluateRecommendTraversal passes complete unique traversal", () => {
  const result = {
    requestedSteps: 3,
    tabSwitches: [
      { requestedLabel: "推荐", alreadyActive: true, active: true, cardCount: 20 },
      { requestedLabel: "最新", clicked: true, active: true, cardCount: 20 }
    ],
    items: [
      { step: 0, snapshot: { modalOpen: true, textHash: "a", textCharCount: 200 } },
      { step: 1, snapshot: { modalOpen: true, textHash: "b", textCharCount: 200 } },
      { step: 2, snapshot: { modalOpen: true, textHash: "c", textCharCount: 200 } }
    ],
    closeAction: { closed: true }
  };

  assert.deepEqual(evaluateRecommendTraversal(result), {
    passed: true,
    failures: []
  });
});

test("evaluateRecommendTraversal rejects stale modal and missing close", () => {
  const result = {
    requestedSteps: 2,
    tabSwitches: [
      { requestedLabel: "推荐", active: true, cardCount: 20 }
    ],
    items: [
      { step: 0, snapshot: { modalOpen: true, textHash: "a", textCharCount: 200 } },
      { step: 1, snapshot: { modalOpen: true, textHash: "a", textCharCount: 200 } }
    ],
    closeAction: { closed: false }
  };

  const evaluation = evaluateRecommendTraversal(result);
  assert.equal(evaluation.passed, false);
  assert.equal(evaluation.failures.includes("duplicate_or_stale_modal_snapshots"), true);
  assert.equal(evaluation.failures.includes("modal_not_closed"), true);
});

test("summarizeRecommendTraversal reports high-level counters", () => {
  const summary = summarizeRecommendTraversal({
    passed: true,
    requestedSteps: 2,
    tabSwitches: [
      { requestedLabel: "推荐", alreadyActive: true, active: true, cardCount: 20 },
      { requestedLabel: "最新", clicked: true, active: true, cardCount: 20 }
    ],
    items: [
      { step: 0, snapshot: { modalOpen: true, textHash: "a", textCharCount: 200 } },
      { step: 1, snapshot: { modalOpen: true, textHash: "b", textCharCount: 200 } }
    ],
    closeAction: { closed: true }
  });

  assert.deepEqual(summary, {
    ok: true,
    requestedSteps: 2,
    traversedSteps: 2,
    uniqueSnapshots: 2,
    tabSwitchCount: 2,
    closeVerified: true,
    failures: []
  });
});
