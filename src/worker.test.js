import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ENV_HOME, RUN_KINDS, RUN_WORKFLOWS } from "./constants.js";
import { createRunSnapshot, readRunState } from "./run-state.js";
import { runWorker } from "./worker.js";

test("runWorker executes async P23 recommend dry-run workflow with injected executor", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-worker-"));
  await withRuntimeHome(workspaceRoot, async () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.RECOMMEND,
      phase: "P23",
      input: {
        workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
        mock_llm: true,
        candidate_limit: 2
      }
    });

    await runWorker({
      workspaceRoot,
      runId: snapshot.run_id,
      executors: {
        recommendDryRun: async () => ({
          passed: true,
          dryRun: true,
          requestedCandidateLimit: 2,
          processedCandidates: 2,
          screenableCandidates: 2,
          llmCalls: 2,
          actionClicks: 0,
          closeAction: { closed: true },
          violations: [],
          items: [
            {
              index: 0,
              textHash: "a",
              actionExecuted: false,
              coverage: { passed: true },
              decision: { decision: "fail", post_action: "none" }
            },
            {
              index: 1,
              textHash: "b",
              actionExecuted: false,
              coverage: { passed: true },
              decision: { decision: "fail", post_action: "none" }
            }
          ]
        })
      }
    });

    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(stored.state, "completed");
    assert.equal(stored.result.workflow, RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING);
    assert.equal(stored.result.summary.ok, true);
    assert.equal(stored.result.summary.processedCandidates, 2);
    assert.equal(stored.artifact_summary.itemCount, 2);
    const decisions = JSON.parse(fs.readFileSync(stored.artifacts.decisionPath, "utf8"));
    const screenInput = JSON.parse(fs.readFileSync(stored.artifacts.screenInputPath, "utf8"));
    assert.equal(decisions.decisions.length, 2);
    assert.equal(screenInput.items.length, 2);
  });
});

test("runWorker blocks recommend-chat chain without explicit chat approval", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-worker-"));
  await withRuntimeHome(workspaceRoot, async () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.RECOMMEND_CHAT,
      phase: "P24",
      input: {
        workflow: RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
        mock_llm: true,
        candidate_limit: 1
      }
    });
    let executorCalled = false;

    await runWorker({
      workspaceRoot,
      runId: snapshot.run_id,
      executors: {
        recommendChatChain: async () => {
          executorCalled = true;
          return { passed: true, items: [] };
        }
      }
    });

    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(executorCalled, false);
    assert.equal(stored.state, "failed");
    assert.equal(stored.error.code, "SIDE_EFFECT_APPROVAL_REQUIRED");
  });
});

test("runWorker persists recommend-chat chain progress emitted by executor", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-worker-"));
  await withRuntimeHome(workspaceRoot, async () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.RECOMMEND_CHAT,
      phase: "P28",
      input: {
        workflow: RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
        mock_llm: true,
        candidate_limit: 1,
        allow_chat_action: true
      }
    });

    await runWorker({
      workspaceRoot,
      runId: snapshot.run_id,
      executors: {
        recommendChatChain: async (_browser, { onProgress }) => {
          onProgress({
            stage: "chat_llm",
            statusMessage: "正在评估聊天状态：张三",
            progress: {
              workflow: RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
              currentScan: 1,
              currentTarget: 1,
              scannedCandidates: 0,
              chainedCandidates: 1,
              currentCandidateLabel: "张三"
            }
          });
          onProgress({
            stage: "candidate_completed",
            statusMessage: "候选人已完成：张三 -> chat_screened_no_action",
            progress: {
              workflow: RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
              currentScan: 1,
              currentTarget: 1,
              scannedCandidates: 1,
              chainedCandidates: 1,
              samePageChatEntries: 1,
              screenableChatEntries: 1,
              recommendLlmCalls: 1,
              chatLlmCalls: 1,
              recommendChatClicks: 1,
              requestResumeClicks: 0,
              actionClicks: 1,
              currentCandidateLabel: "张三",
              lastItem: {
                index: 0,
                status: "chat_screened_no_action"
              }
            }
          });
          return {
            passed: true,
            requestedCandidateLimit: 1,
            scannedCandidates: 1,
            chainedCandidates: 1,
            samePageChatEntries: 1,
            chatPageEntries: 0,
            screenableChatEntries: 1,
            skippedChatEntries: 0,
            recommendLlmCalls: 1,
            chatLlmCalls: 1,
            recommendChatClicks: 1,
            requestResumeClicks: 0,
            actionClicks: 1,
            violations: [],
            items: [
              {
                index: 0,
                candidate: { name: "张三", resumeId: "resume-1" },
                recommendInputManifest: { schemaVersion: "cv" },
                chatInputManifest: { schemaVersion: "chat", missingRequiredSourceIds: [] },
                recommendLlmRequest: { mode: "recommend" },
                chatLlmRequest: { mode: "chat" },
                status: "chat_screened_no_action"
              }
            ]
          };
        }
      }
    });

    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(stored.state, "completed");
    assert.equal(stored.progress.scannedCandidates, 1);
    assert.equal(stored.progress.lastItem.status, "chat_screened_no_action");

    const events = fs.readFileSync(stored.artifacts.eventsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.type === "run_progress"), true);
  });
});

async function withRuntimeHome(workspaceRoot, callback) {
  const previous = process.env[ENV_HOME];
  process.env[ENV_HOME] = path.join(workspaceRoot, ".liepin-home");
  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previous;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}
