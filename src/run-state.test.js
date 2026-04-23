import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ENV_HOME, RUN_WORKFLOWS } from "./constants.js";
import {
  buildWorkflowArtifactPayloads,
  createRunSnapshot,
  markRunFailed,
  markRunCompleted,
  readRunState,
  requestPause,
  summarizeRun,
  updateRunProgress
} from "./run-state.js";

test("createRunSnapshot initializes run artifacts", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-run-state-"));
  withRuntimeHome(workspaceRoot, () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: "recommend",
      input: { sample_limit: 5 }
    });
    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(stored.run_id, snapshot.run_id);
    assert.equal(fs.existsSync(stored.artifacts.eventsPath), true);
  });
});

test("requestPause and markRunCompleted update persisted run", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-run-state-"));
  withRuntimeHome(workspaceRoot, () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: "chat",
      input: {}
    });
    const paused = requestPause(workspaceRoot, snapshot.run_id);
    assert.equal(paused.control.pause_requested, true);
    const completed = markRunCompleted(workspaceRoot, snapshot.run_id, { sampled_count: 2 });
    assert.equal(completed.state, "completed");
    assert.equal(completed.result.sampled_count, 2);
  });
});

test("summarizeRun keeps operator fields without embedding full workflow result", () => {
  const summary = summarizeRun({
    run_id: "run-1",
    kind: "recommend",
    mode: "async_workflow",
    state: "completed",
    input: { workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING },
    result: {
      workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
      summary: { ok: true, processedCandidates: 2 },
      result: { items: [{ index: 0 }, { index: 1 }] }
    },
    progress: {
      workflow: RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
      currentScan: 2,
      scannedCandidates: 1
    },
    artifacts: { decisionPath: "decision.json" }
  });
  assert.equal(summary.workflow, RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING);
  assert.deepEqual(summary.summary, { ok: true, processedCandidates: 2 });
  assert.equal(summary.progress.currentScan, 2);
  assert.equal(Object.hasOwn(summary, "result"), false);
});

test("updateRunProgress persists stage and progress snapshot while appending an event", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-run-state-"));
  withRuntimeHome(workspaceRoot, () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: "recommend-chat",
      input: {
        workflow: RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN
      }
    });

    const updated = updateRunProgress(workspaceRoot, snapshot.run_id, {
      stage: "chat_llm",
      statusMessage: "正在评估聊天状态：李四",
      progress: {
        workflow: RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
        currentScan: 2,
        currentTarget: 1,
        scannedCandidates: 1,
        chainedCandidates: 1,
        currentCandidateLabel: "李四"
      }
    });

    assert.equal(updated.stage, "chat_llm");
    assert.equal(updated.progress.currentScan, 2);
    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(stored.status_message, "正在评估聊天状态：李四");
    assert.equal(stored.progress.currentCandidateLabel, "李四");

    const events = fs.readFileSync(stored.artifacts.eventsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).type, "run_progress");
    assert.equal(events.at(-1).payload.progress.currentScan, 2);
  });
});

test("buildWorkflowArtifactPayloads extracts screen input, LLM requests, decisions, and coverage", () => {
  const payloads = buildWorkflowArtifactPayloads({
    workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
    summary: { ok: true },
    result: {
      items: [
        {
          index: 0,
          rowKey: "row-1",
          candidateLabel: "候选人A",
          manifest: { schemaVersion: "test" },
          llmRequest: { model: "mock" },
          decision: { decision: "pass", post_action: "chat" },
          coverage: { passed: true }
        }
      ]
    }
  });
  assert.equal(payloads.itemCount, 1);
  assert.equal(payloads.screenInput.items[0].candidateLabel, "候选人A");
  assert.equal(payloads.llmRequest.requests[0].llmRequest.model, "mock");
  assert.equal(payloads.decision.decisions[0].decision.post_action, "chat");
  assert.equal(payloads.coverage.coverage[0].coverage.passed, true);
});

test("buildWorkflowArtifactPayloads keeps chat dry-run llm requests and row indexes", () => {
  const payloads = buildWorkflowArtifactPayloads({
    workflow: "chat_dry_run_screening",
    summary: { ok: true, llmCalls: 1 },
    result: {
      items: [
        {
          rowIndex: 13,
          rowKey: "row-13",
          status: "screened",
          beforeState: {
            rowText: "候选人A 招聘实习生"
          },
          chatInputManifest: {
            schemaVersion: "liepin_chat_screen_input_v1",
            missingRequiredSourceIds: []
          },
          llmRequest: { model: "gemini-3-flash", mode: "chat" },
          decision: { decision: "pass", post_action: "request_resume" }
        }
      ]
    }
  });
  assert.equal(payloads.screenInput.items[0].index, 13);
  assert.equal(payloads.screenInput.items[0].candidateLabel, "候选人A 招聘实习生");
  assert.equal(payloads.llmRequest.requests[0].llmRequest.mode, "chat");
  assert.equal(payloads.decision.decisions[0].wouldPostAction, "request_resume");
  assert.equal(payloads.coverage.coverage[0].missingRequiredSourceIds.length, 0);
});

test("buildWorkflowArtifactPayloads prefers candidate name over generic label", () => {
  const payloads = buildWorkflowArtifactPayloads({
    workflow: "recommend_chat_chain",
    summary: { ok: true },
    result: {
      items: [
        {
          index: 0,
          candidate: {
            name: "程女士",
            label: "推荐职位：",
            resumeId: "resume-1"
          }
        }
      ]
    }
  });

  assert.equal(payloads.screenInput.items[0].candidateLabel, "程女士");
});

test("markRunFailed persists partial workflow artifacts when partial result is provided", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-run-state-"));
  withRuntimeHome(workspaceRoot, () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: "recommend",
      input: {
        workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING
      }
    });
    const failed = markRunFailed(workspaceRoot, snapshot.run_id, {
      code: "WORKER_UNEXPECTED_ERROR",
      message: "test failed"
    }, {
      workflowResult: {
        workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
        summary: {
          ok: false
        },
        result: {
          items: [
            {
              index: 0,
              rowKey: "row-1",
              decision: { decision: "fail", post_action: "none" }
            }
          ]
        }
      }
    });
    assert.equal(failed.state, "failed");
    assert.equal(failed.artifact_summary.itemCount, 1);
    const decisionArtifact = JSON.parse(fs.readFileSync(failed.artifacts.decisionPath, "utf8"));
    assert.equal(decisionArtifact.decisions.length, 1);
  });
});

function withRuntimeHome(workspaceRoot, callback) {
  const previous = process.env[ENV_HOME];
  process.env[ENV_HOME] = path.join(workspaceRoot, ".liepin-home");
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previous;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}
