import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyLongRunFailure,
  createLongRunRuntime,
  normalizeRobustnessMode,
  parseHeartbeatIntervalMs
} from "./long-run-runtime.js";

test("normalizeRobustnessMode defaults unknown values to off", () => {
  assert.equal(normalizeRobustnessMode("observe"), "observe");
  assert.equal(normalizeRobustnessMode("RECOVER"), "recover");
  assert.equal(normalizeRobustnessMode("bad-mode"), "off");
  assert.equal(parseHeartbeatIntervalMs(1), 5000);
});

test("classifyLongRunFailure separates terminal and recoverable failures", () => {
  assert.deepEqual(classifyLongRunFailure(new Error("Runtime.evaluate timed out after 30000ms")), {
    category: "recoverable",
    reason: "transient_browser_or_cdp_failure",
    recoverable: true
  });
  assert.deepEqual(classifyLongRunFailure(new Error("购买开聊卡")), {
    category: "terminal",
    reason: "communication_quota_exhausted",
    recoverable: false
  });
});

test("observe runtime records candidate timing and unrefs heartbeat", () => {
  const events = [];
  let clock = Date.parse("2026-05-09T00:00:00.000Z");
  let unrefCalled = false;
  let cleared = false;
  let heartbeatCallback = null;
  const runtime = createLongRunRuntime({
    mode: "observe",
    workflow: "recommend_chat_chain",
    runId: "run-1",
    appendEvent: (type, payload) => events.push({ type, payload }),
    now: () => clock,
    setIntervalFn: (callback, intervalMs) => {
      heartbeatCallback = callback;
      return {
        intervalMs,
        unref() {
          unrefCalled = true;
        }
      };
    },
    clearIntervalFn: () => {
      cleared = true;
    },
    heartbeatIntervalMs: 5000
  });

  runtime.start();
  clock += 10;
  runtime.observeProgress({
    stage: "recommend_llm",
    statusMessage: "正在评估推荐候选人：张三",
    progress: {
      workflow: "recommend_chat_chain",
      currentCandidateLabel: "张三",
      currentScan: 1
    }
  });
  clock += 25;
  runtime.observeProgress({
    stage: "candidate_completed",
    progress: {
      workflow: "recommend_chat_chain",
      lastItem: {
        index: 0,
        status: "chat_screened_no_action"
      }
    }
  });
  heartbeatCallback();
  runtime.stop();

  assert.equal(unrefCalled, true);
  assert.equal(cleared, true);
  assert.equal(events.some((event) => event.type === "candidate_started"), true);
  assert.equal(events.some((event) => event.type === "candidate_finished"), true);
  assert.equal(events.some((event) => event.type === "run_heartbeat"), true);
  assert.equal(runtime.buildSummary().candidateDurationMs.p50, 25);
});
