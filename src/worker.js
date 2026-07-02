import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ROBUSTNESS_MODE,
  DEFAULT_RECOMMEND_STEP_DELAY_MS,
  RUN_KINDS,
  RUN_WORKFLOWS
} from "./constants.js";
import { getWorkspaceRoot, readScreeningConfig } from "./config.js";
import {
  appendRunEvent,
  getRunArtifactPaths,
  markRunCanceled,
  markRunCompleted,
  markRunFailed,
  markRunPaused,
  markRunRunning,
  readRunState,
  isRunTerminal,
  updateRunProgress
} from "./run-state.js";
import { sampleChatResumeDetailResumes } from "./liepin/chat-sampler.js";
import { runCvStructureSurvey } from "./liepin/cv-survey.js";
import { sampleRecommendDetailedResumes } from "./liepin/recommend-sampler.js";
import {
  buildMockChatScreeningProvider,
  runChatDryRunScreening,
  summarizeChatDryRunScreening
} from "./liepin/chat-dry-run-screening.js";
import {
  runChatScreening,
  summarizeChatScreening
} from "./liepin/chat-screening.js";
import {
  buildMockRecommendScreeningProvider,
  runRecommendDryRunScreening,
  summarizeRecommendDryRunScreening
} from "./liepin/recommend-dry-run-screening.js";
import {
  buildRecommendFilterPlanFromText,
  executeRecommendFilters,
  shouldApplyRecommendFilter
} from "./liepin/recommend-filter-executor.js";
import {
  runRecommendChatChain,
  summarizeRecommendChatChain
} from "./liepin/recommend-chat-chain.js";
import {
  runSearchChatChain,
  summarizeSearchChatChain
} from "./liepin/search-chat-chain.js";
import {
  createLongRunRuntime,
  normalizeRobustnessMode,
  parseHeartbeatIntervalMs
} from "./long-run-runtime.js";
import { isAllCandidateLimit, normalizeText, parsePositiveInteger, readJsonFile, writeJsonFile } from "./utils.js";

export async function runWorker({
  workspaceRoot = getWorkspaceRoot(),
  runId,
  executors = createDefaultExecutors()
}) {
  const snapshot = readRunState(workspaceRoot, runId);
  if (!snapshot) throw new Error(`Run not found: ${runId}`);
  if (isRunTerminal(snapshot)) {
    appendRunEvent(snapshot, "worker_skipped_terminal_run", {
      state: snapshot.state
    });
    return;
  }
  if (snapshot.control?.cancel_requested) {
    markRunCanceled(workspaceRoot, runId, { reason: "cancelled_before_start" });
    return;
  }
  const selectedWorkflow = normalizeText(snapshot.input?.workflow) || legacyWorkflowForKind(snapshot.kind);
  const artifacts = snapshot.artifacts || getRunArtifactPaths(workspaceRoot, runId);
  const robustnessRuntime = createLongRunRuntime({
    mode: normalizeRobustnessMode(snapshot.input?.robustness_mode, DEFAULT_ROBUSTNESS_MODE),
    workflow: selectedWorkflow,
    runId,
    checkpointPath: artifacts.checkpointPath,
    heartbeatIntervalMs: parseHeartbeatIntervalMs(snapshot.input?.heartbeat_interval_ms),
    appendEvent: (type, payload) => appendRunEvent(snapshot, type, payload)
  });

  markRunRunning(workspaceRoot, runId);
  appendRunEvent(readRunState(workspaceRoot, runId), "worker_started", {
    pid: process.pid
  });

  let lastPartialWorkflowResult = null;
  const checkRunControl = (partialResult = null) => {
    if (partialResult) {
      lastPartialWorkflowResult = partialResult;
    }
    const current = readRunState(workspaceRoot, runId);
    if (current?.control?.cancel_requested) {
      throw createRunControlInterruptError({
        code: "RUN_CANCELED",
        message: "Run canceled by operator.",
        partialResult: lastPartialWorkflowResult
      });
    }
    if (current?.control?.pause_requested) {
      throw createRunControlInterruptError({
        code: "RUN_PAUSED",
        message: "Run paused by operator.",
        partialResult: lastPartialWorkflowResult
      });
    }
  };
  const onProgress = (event = {}) => {
    robustnessRuntime.observeProgress(event);
    updateRunProgress(workspaceRoot, runId, event);
    if (event.partialResult) {
      lastPartialWorkflowResult = event.partialResult;
    }
    if (selectedWorkflow === RUN_WORKFLOWS.SEARCH_CHAT_CHAIN) return;
    checkRunControl(lastPartialWorkflowResult);
  };
  const onSafeControlPoint = (partialResult = null) => {
    checkRunControl(partialResult || lastPartialWorkflowResult);
  };

  try {
    if (snapshot.control?.pause_requested) {
      markRunPaused(workspaceRoot, runId, { stage: "before_browser_work" });
      return;
    }
    robustnessRuntime.start();

    const result = await executeWorkflow({
      workspaceRoot,
      snapshot,
      executors,
      onProgress,
      onSafeControlPoint,
      robustnessRuntime
    });
    robustnessRuntime.stop();
    markRunCompleted(workspaceRoot, runId, robustnessRuntime.decorateResult(result));
  } catch (error) {
    const partialWorkflowResult = error?.partialResult || lastPartialWorkflowResult || null;
    if (error?.code === "RUN_PAUSED") {
      robustnessRuntime.stop();
      markRunPaused(workspaceRoot, runId, robustnessRuntime.decorateResult(partialWorkflowResult || {
        reason: "paused_by_operator"
      }));
      return;
    }
    if (error?.code === "RUN_CANCELED") {
      robustnessRuntime.stop();
      markRunCanceled(workspaceRoot, runId, robustnessRuntime.decorateResult(partialWorkflowResult || {
        reason: "canceled_by_operator"
      }));
      return;
    }
    const robustnessFailure = robustnessRuntime.recordFailure(error);
    robustnessRuntime.stop();
    markRunFailed(workspaceRoot, runId, {
      code: error?.code || "WORKER_UNEXPECTED_ERROR",
      message: error?.message || "Unexpected worker error",
      robustnessFailure
    }, {
      workflowResult: robustnessRuntime.decorateResult(partialWorkflowResult)
    });
  }
}

export async function executeWorkflow({
  workspaceRoot,
  snapshot,
  executors = createDefaultExecutors(),
  onProgress = null,
  onSafeControlPoint = null,
  robustnessRuntime = null
}) {
  const input = snapshot.input || {};
  const workflow = normalizeText(input.workflow) || legacyWorkflowForKind(snapshot.kind);
  const port = parsePositiveInteger(input.debug_port, 9222);
  appendRunEvent(snapshot, "workflow_selected", {
    workflow
  });
  assertSideEffectApproval(workflow, input);

  if (workflow === RUN_WORKFLOWS.RECOMMEND_SAMPLE) {
    const samples = await executors.recommendSample({ port }, {
      limit: parsePositiveInteger(input.sample_limit, 5)
    });
    return {
      workflow,
      summary: {
        sampled_count: samples.length,
        source: "recommend_modal"
      },
      samples
    };
  }

  if (workflow === RUN_WORKFLOWS.CHAT_SAMPLE) {
    const samples = await executors.chatSample({ port }, {
      limit: parsePositiveInteger(input.sample_limit, 5),
      conversationFilterLabel: normalizeText(input.filter) || null
    });
    return {
      workflow,
      summary: {
        sampled_count: samples.length,
        source: "chat_resume_detail"
      },
      samples
    };
  }

  if (workflow === RUN_WORKFLOWS.CV_SURVEY) {
    const result = await executors.cvSurvey({
      workspaceRoot,
      minimumSamples: parsePositiveInteger(input.minimum_samples, 50),
      batchSize: parsePositiveInteger(input.batch_size, 10),
      recommendSampler: async (limit) => executors.recommendSample({ port, tabLabel: "推荐" }, { limit }),
      latestRecommendSampler: async (limit) => executors.recommendSample({ port, tabLabel: "最新" }, { limit }),
      chatSampler: async (limit) => executors.chatSample({ port }, { limit })
    });
    return {
      workflow,
      summary: {
        sampled_count: result.sampledCount || result.samples?.length || 0,
        unique_structure_count: result.uniqueStructureCount || result.uniqueStructures?.length || 0,
        output_path: result.outputPath || null
      },
      result
    };
  }

  if (workflow === RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING) {
    const llm = resolveRecommendDryRunLlm(workspaceRoot, input);
    const result = await executors.recommendDryRun({ port }, {
      candidateLimit: parsePositiveInteger(input.candidate_limit, parsePositiveInteger(input.sample_limit, 20)),
      scanLimit: parsePositiveInteger(input.scan_limit, null),
      tabLabel: normalizeText(input.tab) || "推荐",
      startIndex: parseNonNegativeInteger(input.start_index, 0),
      stepDelayMs: parsePositiveInteger(input.step_delay_ms, DEFAULT_RECOMMEND_STEP_DELAY_MS),
      maxPayloadChars: parsePositiveInteger(input.max_chars, null),
      criteria: normalizeText(input.criteria) || null,
      operatorFilter: normalizeText(input.filter) || null,
      config: llm.config,
      provider: llm.provider,
      onProgress
    });
    return {
      workflow,
      summary: summarizeRecommendDryRunScreening(result),
      result
    };
  }

  if (workflow === RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING) {
    const llm = resolveChatDryRunLlm(workspaceRoot, input);
    const result = await executors.chatDryRun({ port }, {
      candidateLimit: parsePositiveInteger(input.candidate_limit, parsePositiveInteger(input.sample_limit, 20)),
      rowLimit: parsePositiveInteger(input.row_limit, 40),
      maxScrollPasses: parsePositiveInteger(input.max_scroll_passes, 3),
      conversationFilterLabel: normalizeText(input.filter) || "有简历",
      criteria: normalizeText(input.criteria) || null,
      config: llm.config,
      provider: llm.provider,
      onProgress
    });
    return {
      workflow,
      summary: summarizeChatDryRunScreening(result),
      result
    };
  }

  if (workflow === RUN_WORKFLOWS.CHAT_SCREENING) {
    const normalizedCriteria = normalizeText(input.criteria) || null;
    const llm = normalizedCriteria
      ? resolveChatScreeningLlm(workspaceRoot, input)
      : { config: null, provider: null };
    const result = await executors.chatScreening({ port }, {
      candidateLimit: Object.hasOwn(input, "candidate_limit")
        ? parseChatCandidateLimitInput(input.candidate_limit)
        : undefined,
      scanLimit: parsePositiveInteger(input.scan_limit, null),
      jobTitle: normalizeText(input.job || input.job_title) || null,
      unreadOnly: parseBooleanInput(input.unread_only, null),
      maxPayloadChars: parsePositiveInteger(input.max_chars, null),
      criteria: normalizedCriteria,
      config: llm.config,
      provider: llm.provider,
      humanBehavior: input,
      onProgress
    });
    return {
      workflow,
      summary: summarizeChatScreening(result),
      result
    };
  }

  if (workflow === RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN) {
    const llm = resolveRecommendChatChainLlm(workspaceRoot, input);
    const filterPlan = buildRecommendFilterPlanFromText(input.filter);
    let filterExecution = null;
    if (shouldApplyRecommendFilter(input.filter) && filterPlan.length > 0) {
      filterExecution = await executors.recommendFilters({ port }, {
        plan: filterPlan,
        restore: false
      });
      if (!filterExecution?.passed) {
        throw createWorkflowError(
          "RECOMMEND_FILTER_APPLY_FAILED",
          `推荐页筛选条件应用失败：${JSON.stringify(filterExecution?.actions || filterExecution || {})}`
        );
      }
    }
    const result = await executors.recommendChatChain({ port }, {
      candidateLimit: parsePositiveInteger(input.candidate_limit, 5),
      scanLimit: parsePositiveInteger(input.scan_limit, null),
      tabLabel: normalizeText(input.tab) || "推荐",
      startIndex: parseNonNegativeInteger(input.start_index, 0),
      stepDelayMs: parsePositiveInteger(input.step_delay_ms, DEFAULT_RECOMMEND_STEP_DELAY_MS),
      chatEntryTimeoutMs: parsePositiveInteger(input.chat_entry_timeout_ms, 30000),
      maxPayloadChars: parsePositiveInteger(input.max_chars, null),
      recommendCriteria: normalizeText(input.recommend_criteria || input.criteria) || null,
      chatCriteria: normalizeText(input.chat_criteria || input.criteria) || null,
      operatorFilter: normalizeText(input.filter) || null,
      executeRequestResume: Boolean(input.execute_request_resume),
      config: llm.config,
      recommendProvider: llm.recommendProvider,
      chatProvider: llm.chatProvider,
      onProgress
    });
    if (filterExecution) {
      result.filterExecution = filterExecution;
    }
    return {
      workflow,
      summary: summarizeRecommendChatChain(result),
      result
    };
  }

  if (workflow === RUN_WORKFLOWS.SEARCH_CHAT_CHAIN) {
    const llm = resolveSearchChatChainLlm(workspaceRoot, input);
    const artifacts = snapshot.artifacts || getRunArtifactPaths(workspaceRoot, snapshot.run_id);
    const checkpoint = readJsonFile(artifacts.checkpointPath, null);
    const result = await executors.searchChatChain({ port }, {
      candidateLimit: parsePositiveInteger(input.candidate_limit, 5),
      scanLimit: parsePositiveInteger(input.scan_limit, null),
      profile: normalizeText(input.profile || input.search_profile) || null,
      jobTitle: normalizeText(input.job || input.job_title) || null,
      hideRead: parseBooleanInput(input.hide_read, false),
      startIndex: parseNonNegativeInteger(input.start_index, 0),
      stepDelayMs: parsePositiveInteger(input.step_delay_ms, DEFAULT_RECOMMEND_STEP_DELAY_MS),
      maxPayloadChars: parsePositiveInteger(input.max_chars, null),
      criteria: normalizeText(input.criteria || input.recommend_criteria) || null,
      operatorFilter: normalizeText(input.filter) || null,
      config: llm.config,
      provider: llm.provider,
      checkpoint,
      robustnessMode: robustnessRuntime?.mode || DEFAULT_ROBUSTNESS_MODE,
      onCheckpoint: async (checkpointPayload) => {
        const writer = async (payload) => {
          writeJsonFile(artifacts.checkpointPath, payload);
        };
        if (robustnessRuntime?.enabled) {
          await robustnessRuntime.recordCheckpointWrite(writer, checkpointPayload);
          return;
        }
        await writer(checkpointPayload);
      },
      onSafeControlPoint,
      onProgress
    });
    return {
      workflow,
      summary: summarizeSearchChatChain(result),
      result
    };
  }

  throw new Error(`Unsupported run workflow: ${workflow || "(empty)"}`);
}

function assertSideEffectApproval(workflow, input = {}) {
  const allowChatAction = input.allow_chat_action ?? true;
  const allowRequestResume = input.allow_request_resume ?? true;
  if (workflow === RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN && !allowChatAction) {
    throw createWorkflowError(
      "SIDE_EFFECT_APPROVAL_REQUIRED",
      "recommend_chat_chain 会点击推荐沟通按钮；如需正式串联请允许 allow_chat_action，或改用 dry-run workflow。"
    );
  }
  if (workflow === RUN_WORKFLOWS.SEARCH_CHAT_CHAIN && !allowChatAction) {
    throw createWorkflowError(
      "SIDE_EFFECT_APPROVAL_REQUIRED",
      "search_chat_chain 会点击搜索页立即沟通按钮；如需正式串联请允许 allow_chat_action。"
    );
  }
  if (
    workflow === RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN
    && input.execute_request_resume
    && !allowRequestResume
  ) {
    throw createWorkflowError(
      "SIDE_EFFECT_APPROVAL_REQUIRED",
      "execute_request_resume 会真实索要简历；如需索要简历请允许 allow_request_resume，或关闭 execute_request_resume。"
    );
  }
  if (workflow === RUN_WORKFLOWS.CHAT_SCREENING && !allowRequestResume) {
    throw createWorkflowError(
      "SIDE_EFFECT_APPROVAL_REQUIRED",
      "chat_screening 会真实索要简历；如需索要简历请允许 allow_request_resume。"
    );
  }
}

function createWorkflowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createDefaultExecutors() {
  return {
    recommendSample: sampleRecommendDetailedResumes,
    chatSample: sampleChatResumeDetailResumes,
    cvSurvey: runCvStructureSurvey,
    recommendDryRun: runRecommendDryRunScreening,
    chatDryRun: runChatDryRunScreening,
    chatScreening: runChatScreening,
    recommendFilters: executeRecommendFilters,
    recommendChatChain: runRecommendChatChain,
    searchChatChain: runSearchChatChain
  };
}

function legacyWorkflowForKind(kind) {
  if (kind === RUN_KINDS.RECOMMEND) return RUN_WORKFLOWS.RECOMMEND_SAMPLE;
  if (kind === RUN_KINDS.CHAT) return RUN_WORKFLOWS.CHAT_SAMPLE;
  if (kind === RUN_KINDS.RECOMMEND_CHAT) return RUN_WORKFLOWS.CV_SURVEY;
  if (kind === RUN_KINDS.SEARCH) return RUN_WORKFLOWS.SEARCH_CHAT_CHAIN;
  return "";
}

function resolveRecommendDryRunLlm(workspaceRoot, input) {
  if (input.mock_llm) {
    return {
      config: {
        model: normalizeText(input.mock_model) || "mock-recommend-dry-run"
      },
      provider: buildMockRecommendScreeningProvider({
        decision: normalizeText(input.mock_decision) || "fail",
        postAction: normalizeText(input.mock_post_action) || "none",
        reasoningText: normalizeText(input.mock_reasoning)
      })
    };
  }
  return resolveRequiredConfig(workspaceRoot);
}

function resolveChatDryRunLlm(workspaceRoot, input) {
  if (input.mock_llm) {
    return {
      config: {
        model: normalizeText(input.mock_model) || "mock-chat-dry-run"
      },
      provider: buildMockChatScreeningProvider({
        decision: normalizeText(input.mock_decision) || "fail",
        postAction: normalizeText(input.mock_post_action) || "none",
        reasoningText: normalizeText(input.mock_reasoning)
      })
    };
  }
  return resolveRequiredConfig(workspaceRoot);
}

function resolveChatScreeningLlm(workspaceRoot, input) {
  if (input.mock_llm) {
    return {
      config: {
        model: normalizeText(input.mock_model) || "mock-chat-screening"
      },
      provider: buildMockChatScreeningProvider({
        decision: normalizeText(input.mock_chat_decision || input.mock_decision) || "fail",
        postAction: normalizeText(input.mock_chat_post_action || input.mock_post_action) || "none",
        reasoningText: normalizeText(input.mock_reasoning)
      })
    };
  }
  return resolveRequiredConfig(workspaceRoot);
}

function resolveRecommendChatChainLlm(workspaceRoot, input) {
  if (input.mock_llm) {
    return {
      config: {
        model: normalizeText(input.mock_model) || "mock-recommend-chat-chain"
      },
      recommendProvider: buildMockRecommendScreeningProvider({
        decision: normalizeText(input.mock_recommend_decision || input.mock_decision) || "pass",
        postAction: normalizeText(input.mock_recommend_post_action || input.mock_post_action) || "chat",
        reasoningText: normalizeText(input.mock_reasoning)
      }),
      chatProvider: buildMockChatScreeningProvider({
        decision: normalizeText(input.mock_chat_decision || input.mock_decision) || "pass",
        postAction: normalizeText(input.mock_chat_post_action) || "request_resume",
        reasoningText: normalizeText(input.mock_reasoning)
      })
    };
  }
  const config = resolveRequiredConfig(workspaceRoot).config;
  return {
    config,
    recommendProvider: null,
    chatProvider: null
  };
}

function resolveSearchChatChainLlm(workspaceRoot, input) {
  if (input.mock_llm) {
    return {
      config: {
        model: normalizeText(input.mock_model) || "mock-search-chat-chain"
      },
      provider: buildMockRecommendScreeningProvider({
        decision: normalizeText(input.mock_recommend_decision || input.mock_decision) || "pass",
        postAction: normalizeText(input.mock_recommend_post_action || input.mock_post_action) || "chat",
        reasoningText: normalizeText(input.mock_reasoning)
      })
    };
  }
  return resolveRequiredConfig(workspaceRoot);
}

function resolveRequiredConfig(workspaceRoot) {
  const resolution = readScreeningConfig(workspaceRoot);
  if (!resolution.ok) {
    throw new Error(`${resolution.error.message} 如需无密钥验收异步 dry-run，请显式传入 mock_llm/--mock-llm。`);
  }
  return {
    config: resolution.config,
    provider: null
  };
}

function parseNonNegativeInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBooleanInput(value, fallback = null) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  const normalized = normalizeText(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseChatCandidateLimitInput(value) {
  if (value === null || isAllCandidateLimit(value)) return null;
  const parsed = parsePositiveInteger(value, null);
  return parsed || undefined;
}

function createRunControlInterruptError({
  code,
  message,
  partialResult = null
} = {}) {
  const error = new Error(message || "Run control interrupted.");
  error.code = code || "RUN_INTERRUPTED";
  if (partialResult) {
    error.partialResult = partialResult;
  }
  return error;
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFilePath)) {
  const runId = process.argv[process.argv.indexOf("--run-id") + 1];
  runWorker({
    workspaceRoot: process.argv.includes("--workspace-root")
      ? path.resolve(process.argv[process.argv.indexOf("--workspace-root") + 1])
      : getWorkspaceRoot(),
    runId
  }).catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
