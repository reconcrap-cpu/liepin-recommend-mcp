import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBottomAudit, summarizeInfiniteScrollAudit } from "./infinite-scroll.js";

test("evaluateBottomAudit confirms bottom only after stable probe", () => {
  assert.deepEqual(evaluateBottomAudit({
    final: { atBottom: true },
    probeChanged: false,
    maxPassesReached: false
  }), {
    reachedBottom: true,
    terminalSignalRequired: false,
    terminalSignalConfirmed: false,
    terminalSignalMissing: false,
    falseBottomDetected: false,
    bottomConfirmed: true,
    passed: true
  });
});

test("evaluateBottomAudit rejects false bottom and max pass exhaustion", () => {
  assert.equal(evaluateBottomAudit({
    final: { atBottom: true },
    probeChanged: true,
    maxPassesReached: false
  }).passed, false);
  assert.equal(evaluateBottomAudit({
    final: { atBottom: true },
    probeChanged: false,
    maxPassesReached: true
  }).passed, false);
  assert.equal(evaluateBottomAudit({
    final: { atBottom: true, bottomTextSignals: false },
    probeChanged: false,
    maxPassesReached: false,
    terminalSignalRequired: true
  }).passed, false);
  assert.equal(evaluateBottomAudit({
    final: { atBottom: true, bottomTextSignals: true },
    probeChanged: false,
    maxPassesReached: false,
    terminalSignalRequired: true
  }).passed, true);
});

test("summarizeInfiniteScrollAudit reports item counters", () => {
  const summary = summarizeInfiniteScrollAudit({
    passed: true,
    kind: "recommend",
    bottomConfirmed: true,
    terminalSignalRequired: true,
    terminalSignalConfirmed: true,
    reachedBottom: true,
    falseBottomDetected: false,
    terminalSignalMissing: false,
    maxPassesReached: false,
    initial: { itemCount: 20 },
    final: { itemCount: 60, uniqueItemCount: 60 },
    passes: [{}, {}]
  });

  assert.deepEqual(summary, {
    ok: true,
    kind: "recommend",
    bottomConfirmed: true,
    terminalSignalRequired: true,
    terminalSignalConfirmed: true,
    reachedBottom: true,
    falseBottomDetected: false,
    terminalSignalMissing: false,
    maxPassesReached: false,
    passCount: 2,
    initialItemCount: 20,
    finalItemCount: 60,
    uniqueItemCount: 60
  });
});
