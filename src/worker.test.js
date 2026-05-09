import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ENV_HOME, RUN_KINDS, RUN_WORKFLOWS } from "./constants.js";
import { createRunSnapshot, readRunState, requestPause } from "./run-state.js";
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
          passedCandidates: 2,
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

test("runWorker defaults recommend-chat chain to production approvals", async () => {
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
          return {
            passed: true,
            requestedCandidateLimit: 1,
            scannedCandidates: 1,
            chainedCandidates: 1,
            passedCandidates: 1,
            items: []
          };
        }
      }
    });

    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(executorCalled, true);
    assert.equal(stored.state, "completed");
  });
});

test("runWorker executes search chat-chain workflow with injected executor", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-worker-"));
  await withRuntimeHome(workspaceRoot, async () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.SEARCH,
      phase: "P30",
      input: {
        workflow: RUN_WORKFLOWS.SEARCH_CHAT_CHAIN,
        mock_llm: true,
        profile: "测试",
        job: "招聘实习生",
        hide_read: true,
        candidate_limit: 1
      }
    });

    await runWorker({
      workspaceRoot,
      runId: snapshot.run_id,
      executors: {
        searchChatChain: async (_browser, options) => {
          assert.equal(options.profile, "测试");
          assert.equal(options.jobTitle, "招聘实习生");
          assert.equal(options.hideRead, true);
          return {
            passed: true,
            profile: "测试",
            jobTitle: "招聘实习生",
            hideRead: true,
            hideReadFilter: { verified: true },
            requestedCandidateLimit: 1,
            scannedCandidates: 1,
            passedCandidates: 1,
            llmCalls: 1,
            communicationClicks: 1,
            actionClicks: 1,
            violations: [],
            items: [
              {
                index: 0,
                candidate: { name: "张三", resumeId: "resume-1" },
                inputManifest: { schemaVersion: "cv" },
                llmRequest: { mode: "recommend" },
                decision: { decision: "pass", post_action: "chat" },
                chatAction: { ok: true, clicked: true, status: "search_contacted" },
                status: "search_contacted"
              }
            ]
          };
        }
      }
    });

    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(stored.state, "completed");
    assert.equal(stored.result.workflow, RUN_WORKFLOWS.SEARCH_CHAT_CHAIN);
    assert.equal(stored.result.summary.ok, true);
    assert.equal(stored.artifact_summary.itemCount, 1);
    assert.equal(Boolean(stored.artifact_summary.csvPath), true);
  });
});

test("runWorker executes chat screening workflow with required chat inputs", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-worker-"));
  await withRuntimeHome(workspaceRoot, async () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.CHAT,
      phase: "P31",
      input: {
        workflow: RUN_WORKFLOWS.CHAT_SCREENING,
        mock_llm: true,
        candidate_limit: 2,
        scan_limit: 5,
        job: "全部职位",
        unread_only: false,
        criteria: "筛选条件"
      }
    });

    await runWorker({
      workspaceRoot,
      runId: snapshot.run_id,
      executors: {
        chatScreening: async (_browser, options) => {
          assert.equal(options.candidateLimit, 2);
          assert.equal(options.scanLimit, 5);
          assert.equal(options.jobTitle, "全部职位");
          assert.equal(options.unreadOnly, false);
          assert.equal(options.criteria, "筛选条件");
          return {
            passed: true,
            requestedCandidateLimit: 2,
            requestResumeSuccesses: 2,
            processedCandidates: 3,
            screenableCandidates: 2,
            skippedRows: 1,
            llmCalls: 2,
            actionClicks: 2,
            stopReason: "candidate_limit_reached",
            violations: [],
            items: [
              {
                rowIndex: 0,
                rowKey: "chat-row-1",
                status: "request_resume_succeeded",
                llmCalled: true,
                chatLlmCalled: true,
                decision: { decision: "pass", post_action: "request_resume" },
                chatAction: { ok: true, clicked: true, status: "request_resume_succeeded" },
                reasoningText: "chat screening cot"
              }
            ]
          };
        }
      }
    });

    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(stored.state, "completed");
    assert.equal(stored.result.workflow, RUN_WORKFLOWS.CHAT_SCREENING);
    assert.equal(stored.result.summary.requestResumeSuccesses, 2);
    assert.equal(Boolean(stored.artifact_summary.csvPath), true);
    const csvContent = fs.readFileSync(stored.artifact_summary.csvPath, "utf8");
    assert.equal(csvContent.includes("chat screening cot"), true);
  });
});

test("runWorker passes all-candidates chat limit through as unlimited", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-worker-"));
  await withRuntimeHome(workspaceRoot, async () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.CHAT,
      phase: "P31",
      input: {
        workflow: RUN_WORKFLOWS.CHAT_SCREENING,
        mock_llm: true,
        candidate_limit: "扫到底",
        job: "全部职位",
        unread_only: false,
        criteria: "筛选条件"
      }
    });

    await runWorker({
      workspaceRoot,
      runId: snapshot.run_id,
      executors: {
        chatScreening: async (_browser, options) => {
          assert.equal(options.candidateLimit, null);
          return {
            passed: true,
            requestedCandidateLimit: null,
            scanAllCandidates: true,
            requestResumeSuccesses: 1,
            processedCandidates: 3,
            screenableCandidates: 2,
            skippedRows: 1,
            llmCalls: 2,
            actionClicks: 1,
            stopReason: "list_bottom_reached",
            violations: [],
            items: []
          };
        }
      }
    });

    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(stored.state, "completed");
    assert.equal(stored.result.summary.targetRequestResumeSuccesses, null);
  });
});

test("runWorker pauses search only at safe checkpoint point", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-worker-"));
  await withRuntimeHome(workspaceRoot, async () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.SEARCH,
      phase: "P30",
      input: {
        workflow: RUN_WORKFLOWS.SEARCH_CHAT_CHAIN,
        mock_llm: true,
        profile: "测试",
        job: "招聘实习生",
        candidate_limit: 2
      }
    });

    await runWorker({
      workspaceRoot,
      runId: snapshot.run_id,
      executors: {
        searchChatChain: async (_browser, options) => {
          const partialResult = {
            workflow: RUN_WORKFLOWS.SEARCH_CHAT_CHAIN,
            summary: { ok: false, scannedCandidates: 1 },
            result: {
              items: [
                {
                  index: 0,
                  candidate: { name: "张三", resumeId: "resume-1" },
                  llmCalled: true,
                  decision: { decision: "pass", post_action: "chat" },
                  reasoningText: "search cot",
                  status: "search_contacted",
                  chatAction: { ok: true, clicked: true, status: "search_contacted" }
                }
              ]
            }
          };
          await options.onCheckpoint({
            schemaVersion: "liepin_search_chat_chain_checkpoint_v1",
            profile: "测试",
            jobTitle: "招聘实习生",
            currentPageNumber: 1,
            pageCardIndex: 1,
            items: partialResult.result.items
          });
          requestPause(workspaceRoot, snapshot.run_id);
          options.onSafeControlPoint(partialResult);
          throw new Error("safe control point should interrupt");
        }
      }
    });

    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(stored.state, "paused");
    assert.equal(fs.existsSync(stored.artifact_summary.checkpointPath), true);
    assert.equal(Boolean(stored.artifact_summary.csvPath), true);
    const csvContent = fs.readFileSync(stored.artifact_summary.csvPath, "utf8");
    assert.equal(csvContent.includes("search cot"), true);
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
              passedCandidates: 1,
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
              passedCandidates: 1,
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
            passedCandidates: 1,
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

test("runWorker persists recommend dry-run progress emitted by executor", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-worker-"));
  await withRuntimeHome(workspaceRoot, async () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.RECOMMEND,
      phase: "P29",
      input: {
        workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
        mock_llm: true,
        candidate_limit: 1
      }
    });

    await runWorker({
      workspaceRoot,
      runId: snapshot.run_id,
      executors: {
        recommendDryRun: async (_browser, { onProgress }) => {
          onProgress({
            stage: "candidate_completed",
            statusMessage: "候选人已完成：候选人A",
            progress: {
              workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
              targetCandidates: 1,
              processedCandidates: 1,
              screenableCandidates: 1,
              llmCalls: 1,
              actionClicks: 0,
              currentIndex: 1,
              currentCandidateLabel: "候选人A",
              lastItem: {
                index: 0,
                status: "screened"
              }
            },
            partialResult: {
              workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
              summary: {
                ok: false
              },
              result: {
                items: [
                  { index: 0, rowKey: "row-1", status: "screened" }
                ]
              }
            }
          });
          return {
            passed: true,
            dryRun: true,
            requestedCandidateLimit: 1,
            processedCandidates: 1,
            passedCandidates: 1,
            screenableCandidates: 1,
            llmCalls: 1,
            actionClicks: 0,
            closeAction: { closed: true },
            violations: [],
            items: [
              {
                index: 0,
                rowKey: "row-1",
                status: "screened",
                coverage: { passed: true },
                decision: { decision: "fail", post_action: "none" }
              }
            ]
          };
        }
      }
    });

    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(stored.state, "completed");
    assert.equal(stored.progress.workflow, RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING);
    assert.equal(stored.progress.processedCandidates, 1);
  });
});

test("runWorker leaves robustness runtime off by default", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-worker-"));
  await withRuntimeHome(workspaceRoot, async () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.RECOMMEND,
      phase: "P29",
      input: {
        workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
        mock_llm: true,
        candidate_limit: 1
      }
    });

    await runWorker({
      workspaceRoot,
      runId: snapshot.run_id,
      executors: {
        recommendDryRun: async (_browser, { onProgress }) => {
          onProgress({
            stage: "recommend_llm",
            statusMessage: "正在评估推荐候选人：候选人A",
            progress: {
              workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
              currentCandidateLabel: "候选人A"
            }
          });
          onProgress({
            stage: "candidate_completed",
            statusMessage: "候选人已完成：候选人A",
            progress: {
              workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
              lastItem: { index: 0, status: "screened" }
            }
          });
          return {
            passed: true,
            dryRun: true,
            requestedCandidateLimit: 1,
            processedCandidates: 1,
            passedCandidates: 1,
            screenableCandidates: 1,
            llmCalls: 1,
            actionClicks: 0,
            closeAction: { closed: true },
            violations: [],
            items: [{ index: 0, status: "screened" }]
          };
        }
      }
    });

    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(stored.state, "completed");
    assert.equal(Object.hasOwn(stored.result, "robustness"), false);
    const events = fs.readFileSync(stored.artifacts.eventsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.type === "candidate_started"), false);
    assert.equal(fs.existsSync(stored.artifacts.checkpointPath), false);
  });
});

test("runWorker observe mode records candidate timing and additive checkpoint", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-worker-"));
  await withRuntimeHome(workspaceRoot, async () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.RECOMMEND,
      phase: "P29",
      input: {
        workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
        mock_llm: true,
        candidate_limit: 1,
        robustness_mode: "observe"
      }
    });

    await runWorker({
      workspaceRoot,
      runId: snapshot.run_id,
      executors: {
        recommendDryRun: async (_browser, { onProgress }) => {
          onProgress({
            stage: "recommend_llm",
            statusMessage: "正在评估推荐候选人：候选人A",
            progress: {
              workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
              currentCandidateLabel: "候选人A",
              currentScan: 1
            }
          });
          await new Promise((resolve) => setTimeout(resolve, 5));
          onProgress({
            stage: "candidate_completed",
            statusMessage: "候选人已完成：候选人A",
            progress: {
              workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
              processedCandidates: 1,
              llmCalls: 1,
              lastItem: { index: 0, status: "screened" }
            }
          });
          return {
            passed: true,
            dryRun: true,
            requestedCandidateLimit: 1,
            processedCandidates: 1,
            passedCandidates: 1,
            screenableCandidates: 1,
            llmCalls: 1,
            actionClicks: 0,
            closeAction: { closed: true },
            violations: [],
            items: [{ index: 0, status: "screened" }]
          };
        }
      }
    });

    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(stored.state, "completed");
    assert.equal(stored.result.robustness.mode, "observe");
    assert.equal(stored.result.robustness.candidatesObserved, 1);
    assert.equal(stored.result.robustness.candidateDurationMs.count, 1);
    const checkpoint = JSON.parse(fs.readFileSync(stored.artifacts.checkpointPath, "utf8"));
    assert.equal(checkpoint.schemaVersion, "liepin_long_run_observe_checkpoint_v1");
    assert.equal(checkpoint.workflow, RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING);
    const events = fs.readFileSync(stored.artifacts.eventsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.type === "candidate_started"), true);
    assert.equal(events.some((event) => event.type === "candidate_finished"), true);
    assert.equal(events.some((event) => event.type === "checkpoint_written"), true);
  });
});

test("runWorker keeps partial artifacts when workflow fails after progress", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-worker-"));
  await withRuntimeHome(workspaceRoot, async () => {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.CHAT,
      phase: "P29",
      input: {
        workflow: RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING,
        mock_llm: true,
        candidate_limit: 1
      }
    });

    await runWorker({
      workspaceRoot,
      runId: snapshot.run_id,
      executors: {
        chatDryRun: async (_browser, { onProgress }) => {
          const partialResult = {
            workflow: RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING,
            summary: {
              ok: false,
              processedCandidates: 1
            },
            result: {
              items: [
                {
                  rowIndex: 0,
                  rowKey: "chat-row-1",
                  status: "screened",
                  llmCalled: true,
                  decision: { decision: "pass", post_action: "request_resume" },
                  reasoningText: "chat partial cot"
                }
              ]
            }
          };
          onProgress({
            stage: "candidate_completed",
            statusMessage: "候选人已完成：chat-row-1",
            progress: {
              workflow: RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING,
              targetCandidates: 1,
              processedCandidates: 1,
              llmCalls: 1
            },
            partialResult
          });
          const error = new Error("simulated failure");
          error.partialResult = partialResult;
          throw error;
        }
      }
    });

    const stored = readRunState(workspaceRoot, snapshot.run_id);
    assert.equal(stored.state, "failed");
    assert.equal(stored.artifact_summary.itemCount, 1);
    const screenInput = JSON.parse(fs.readFileSync(stored.artifacts.screenInputPath, "utf8"));
    assert.equal(screenInput.items.length, 1);
    const csvContent = fs.readFileSync(stored.artifact_summary.csvPath, "utf8");
    assert.equal(csvContent.includes("chat partial cot"), true);
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
