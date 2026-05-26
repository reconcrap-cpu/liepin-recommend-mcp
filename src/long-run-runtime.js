import { DEFAULT_ROBUSTNESS_MODE, ROBUSTNESS_MODES } from "./constants.js";
import { normalizeText, toIsoNow, writeJsonFile } from "./utils.js";

export const LONG_RUN_OBSERVE_CHECKPOINT_SCHEMA_VERSION = "liepin_long_run_observe_checkpoint_v1";
export const LONG_RUN_CHECKPOINT_METADATA_SCHEMA_VERSION = "liepin_long_run_checkpoint_metadata_v1";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60000;
const MIN_HEARTBEAT_INTERVAL_MS = 5000;

const CANDIDATE_START_STAGES = new Set([
  "recommend_llm",
  "search_llm",
  "chat_llm",
  "open_resume_modal"
]);

export function normalizeRobustnessMode(value, fallback = DEFAULT_ROBUSTNESS_MODE) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return fallback;
  if (Object.values(ROBUSTNESS_MODES).includes(normalized)) return normalized;
  return fallback;
}

export function parseHeartbeatIntervalMs(value, fallback = DEFAULT_HEARTBEAT_INTERVAL_MS) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(parsed, MIN_HEARTBEAT_INTERVAL_MS);
}

export function classifyLongRunFailure(error) {
  const code = normalizeText(error?.code).toLowerCase();
  const message = normalizeText(error?.message || error).toLowerCase();
  const combined = `${code} ${message}`;

  if (
    combined.includes("communication_quota_exhausted")
    || combined.includes("购买开聊卡")
    || combined.includes("付费沟通")
    || combined.includes("开聊卡")
  ) {
    return {
      category: "terminal",
      reason: "communication_quota_exhausted",
      recoverable: false
    };
  }
  if (
    combined.includes("captcha")
    || combined.includes("risk")
    || combined.includes("safe.liepin.com")
    || combined.includes("验证码")
    || combined.includes("风控")
  ) {
    return {
      category: "terminal",
      reason: "risk_or_captcha_page",
      recoverable: false
    };
  }
  if (combined.includes("login") || combined.includes("登录")) {
    return {
      category: "terminal",
      reason: "login_required",
      recoverable: false
    };
  }
  if (
    combined.includes("runtime.evaluate")
    || combined.includes("timed out")
    || combined.includes("timeout")
    || combined.includes("could not find node")
    || combined.includes("detached")
    || combined.includes("stale")
    || combined.includes("搜索详情弹窗未出现")
    || combined.includes("search detail modal")
    || combined.includes("detail modal")
  ) {
    return {
      category: "recoverable",
      reason: "transient_browser_or_cdp_failure",
      recoverable: true
    };
  }

  return {
    category: "unknown",
    reason: "unclassified",
    recoverable: false
  };
}

export function createLongRunRuntime({
  mode = DEFAULT_ROBUSTNESS_MODE,
  workflow = "",
  runId = "",
  checkpointPath = "",
  appendEvent = null,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  now = () => Date.now(),
  setIntervalFn = globalThis.setInterval,
  clearIntervalFn = globalThis.clearInterval
} = {}) {
  const normalizedMode = normalizeRobustnessMode(mode);
  const enabled = normalizedMode !== ROBUSTNESS_MODES.OFF;
  const metrics = createEmptyMetrics();
  const state = {
    mode: normalizedMode,
    workflow: normalizeText(workflow),
    runId: normalizeText(runId),
    enabled,
    startedAtMs: null,
    lastProgress: null,
    lastProgressAtMs: null,
    activeCandidate: null,
    activePhase: null,
    heartbeatTimer: null,
    stopped: false
  };

  function emit(type, payload = {}) {
    if (!enabled || typeof appendEvent !== "function") return;
    appendEvent(type, {
      robustness_mode: normalizedMode,
      workflow: state.workflow,
      run_id: state.runId,
      ...payload
    });
  }

  function start() {
    if (!enabled || state.startedAtMs !== null) return;
    state.startedAtMs = now();
    emit("robustness_started", {
      heartbeat_interval_ms: parseHeartbeatIntervalMs(heartbeatIntervalMs)
    });
    startHeartbeat();
  }

  function stop() {
    if (!enabled || state.stopped) return;
    state.stopped = true;
    finishActivePhase(now(), "runtime_stopped");
    finishCandidate({
      tsMs: now(),
      status: "runtime_stopped",
      force: false
    });
    if (state.heartbeatTimer && typeof clearIntervalFn === "function") {
      clearIntervalFn(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    emit("robustness_stopped", {
      metrics: buildSummary()
    });
  }

  function startHeartbeat() {
    if (!enabled || typeof setIntervalFn !== "function") return;
    const intervalMs = parseHeartbeatIntervalMs(heartbeatIntervalMs);
    state.heartbeatTimer = setIntervalFn(() => {
      metrics.heartbeatCount += 1;
      emit("run_heartbeat", {
        heartbeat_count: metrics.heartbeatCount,
        current_candidate: state.activeCandidate ? publicCandidate(state.activeCandidate, now()) : null,
        last_progress: state.lastProgress,
        metrics: buildSummary({ includeSamples: false })
      });
    }, intervalMs);
    if (typeof state.heartbeatTimer?.unref === "function") {
      state.heartbeatTimer.unref();
    }
  }

  function observeProgress(event = {}) {
    if (!enabled) return;
    const tsMs = now();
    const stage = normalizeText(event.stage);
    state.lastProgress = sanitizeProgress(event.progress || null);
    state.lastProgressAtMs = tsMs;
    observePhase(stage, tsMs);

    if (CANDIDATE_START_STAGES.has(stage)) {
      startCandidate(event, tsMs);
    }
    if (stage === "candidate_completed") {
      finishCandidate({
        event,
        tsMs,
        status: normalizeText(event.progress?.lastItem?.status) || "candidate_completed",
        force: true
      });
      writeObservationCheckpoint(event, tsMs);
    }
  }

  async function recordCheckpointWrite(writeFn, checkpointPayload, partialResult = null) {
    if (!enabled || typeof writeFn !== "function") {
      return writeFn ? writeFn(checkpointPayload, partialResult) : undefined;
    }
    const startedAt = now();
    const decorated = decorateCheckpoint(checkpointPayload);
    try {
      return await writeFn(decorated, partialResult);
    } finally {
      const durationMs = Math.max(0, now() - startedAt);
      metrics.checkpointWriteDurationsMs.push(durationMs);
      addPhaseDuration("checkpoint_write", durationMs);
      emit("checkpoint_written", {
        duration_ms: durationMs,
        checkpoint_schema_version: normalizeText(checkpointPayload?.schemaVersion)
      });
    }
  }

  function decorateResult(result = {}) {
    if (!enabled || !result || typeof result !== "object") return result;
    return {
      ...result,
      robustness: buildSummary()
    };
  }

  function recordFailure(error) {
    if (!enabled) return null;
    const classification = classifyLongRunFailure(error);
    metrics.failureClassifications.push(classification);
    emit("run_failure_classified", {
      classification,
      error: {
        code: normalizeText(error?.code),
        message: normalizeText(error?.message || error)
      }
    });
    return classification;
  }

  function buildSummary({ includeSamples = true } = {}) {
    const candidateDurations = metrics.candidates
      .map((candidate) => candidate.durationMs)
      .filter((value) => Number.isFinite(value));
    const summary = {
      schemaVersion: "liepin_long_run_metrics_v1",
      mode: normalizedMode,
      workflow: state.workflow,
      heartbeatCount: metrics.heartbeatCount,
      candidatesObserved: metrics.candidates.length,
      candidateDurationMs: percentileSummary(candidateDurations),
      phaseDurationMs: Object.fromEntries(
        Object.entries(metrics.phaseDurationsMs).map(([phase, durations]) => [phase, percentileSummary(durations)])
      ),
      checkpointWriteMs: percentileSummary(metrics.checkpointWriteDurationsMs),
      failureClassifications: metrics.failureClassifications
    };
    if (includeSamples) {
      summary.candidates = metrics.candidates.slice(-10).map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        status: candidate.status,
        duration_ms: candidate.durationMs,
        started_at: candidate.startedAt,
        finished_at: candidate.finishedAt
      }));
    }
    return summary;
  }

  function addPhaseDuration(phase, durationMs) {
    if (!metrics.phaseDurationsMs[phase]) metrics.phaseDurationsMs[phase] = [];
    metrics.phaseDurationsMs[phase].push(durationMs);
  }

  function observePhase(stage, tsMs) {
    const phase = mapStageToPhase(stage);
    if (!phase) return;
    if (state.activePhase?.phase === phase) return;
    finishActivePhase(tsMs, phase);
    state.activePhase = {
      phase,
      startedAtMs: tsMs
    };
  }

  function finishActivePhase(tsMs, nextPhase = "") {
    if (!state.activePhase) return;
    const durationMs = Math.max(0, tsMs - state.activePhase.startedAtMs);
    addPhaseDuration(state.activePhase.phase, durationMs);
    emit("phase_timing", {
      phase: state.activePhase.phase,
      next_phase: nextPhase,
      duration_ms: durationMs
    });
    state.activePhase = null;
  }

  function startCandidate(event, tsMs) {
    const candidate = candidateFromProgress(event, tsMs);
    if (state.activeCandidate?.id === candidate.id) return;
    finishCandidate({
      tsMs,
      status: "interrupted_by_next_candidate",
      force: false
    });
    state.activeCandidate = candidate;
    emit("candidate_started", {
      candidate: publicCandidate(candidate, tsMs)
    });
  }

  function finishCandidate({
    event = {},
    tsMs,
    status = "candidate_completed",
    force = false
  } = {}) {
    if (!state.activeCandidate && force) {
      state.activeCandidate = candidateFromProgress(event, tsMs);
    }
    if (!state.activeCandidate) return;
    const candidate = {
      ...state.activeCandidate,
      status,
      finishedAtMs: tsMs,
      finishedAt: new Date(tsMs).toISOString(),
      durationMs: Math.max(0, tsMs - state.activeCandidate.startedAtMs)
    };
    metrics.candidates.push(candidate);
    emit("candidate_finished", {
      candidate: publicCandidate(candidate, tsMs),
      duration_ms: candidate.durationMs,
      status
    });
    state.activeCandidate = null;
  }

  function writeObservationCheckpoint(event, tsMs) {
    if (!checkpointPath || state.workflow === "search_chat_chain") return;
    const startedAt = now();
    const payload = {
      schemaVersion: LONG_RUN_OBSERVE_CHECKPOINT_SCHEMA_VERSION,
      workflow: state.workflow,
      robustnessMode: normalizedMode,
      updatedAt: new Date(tsMs).toISOString(),
      lastProgress: sanitizeProgress(event.progress || null),
      metrics: buildSummary({ includeSamples: false })
    };
    writeJsonFile(checkpointPath, payload);
    const durationMs = Math.max(0, now() - startedAt);
    metrics.checkpointWriteDurationsMs.push(durationMs);
    addPhaseDuration("checkpoint_write", durationMs);
    emit("checkpoint_written", {
      duration_ms: durationMs,
      checkpoint_schema_version: payload.schemaVersion
    });
  }

  function decorateCheckpoint(checkpointPayload = {}) {
    if (!checkpointPayload || typeof checkpointPayload !== "object") return checkpointPayload;
    return {
      ...checkpointPayload,
      robustness: {
        schemaVersion: LONG_RUN_CHECKPOINT_METADATA_SCHEMA_VERSION,
        mode: normalizedMode,
        workflow: state.workflow,
        updatedAt: toIsoNow(),
        metrics: buildSummary({ includeSamples: false })
      }
    };
  }

  return {
    mode: normalizedMode,
    enabled,
    start,
    stop,
    observeProgress,
    recordCheckpointWrite,
    recordFailure,
    decorateResult,
    buildSummary
  };
}

function createEmptyMetrics() {
  return {
    heartbeatCount: 0,
    candidates: [],
    phaseDurationsMs: {},
    checkpointWriteDurationsMs: [],
    failureClassifications: []
  };
}

function mapStageToPhase(stage) {
  const normalized = normalizeText(stage);
  if (!normalized) return "";
  if (normalized.includes("llm")) return "llm_call";
  if (normalized.includes("health") || normalized.includes("responsive")) return "page_health";
  if (normalized.includes("checkpoint")) return "checkpoint_write";
  if (normalized.includes("return_to_recommend") || normalized.includes("return")) return "return_to_list";
  if (normalized.includes("modal") || normalized.includes("resume")) return "modal_or_resume";
  if (normalized.includes("refresh") || normalized.includes("recovery")) return "recovery";
  return normalized;
}

function candidateFromProgress(event = {}, tsMs = Date.now()) {
  const progress = event.progress || {};
  const lastItem = progress.lastItem || {};
  const id = normalizeText(
    lastItem.rowKey
    || lastItem.resumeId
    || lastItem.candidate?.resumeId
    || progress.currentCandidateKey
    || progress.currentCandidateLabel
    || progress.currentScan
    || progress.currentIndex
    || event.statusMessage
  ) || `candidate-${tsMs}`;
  const label = normalizeText(
    progress.currentCandidateLabel
    || lastItem.candidateLabel
    || lastItem.candidate?.name
    || lastItem.rowKey
    || event.statusMessage
  );
  return {
    id,
    label,
    stage: normalizeText(event.stage),
    startedAtMs: tsMs,
    startedAt: new Date(tsMs).toISOString()
  };
}

function publicCandidate(candidate, nowMs) {
  return {
    id: candidate.id,
    label: candidate.label,
    stage: candidate.stage,
    started_at: candidate.startedAt,
    elapsed_ms: Math.max(0, nowMs - candidate.startedAtMs)
  };
}

function sanitizeProgress(progress) {
  if (!progress || typeof progress !== "object") return null;
  return {
    workflow: progress.workflow || "",
    currentScan: progress.currentScan ?? null,
    currentIndex: progress.currentIndex ?? null,
    currentTarget: progress.currentTarget ?? progress.targetCandidates ?? null,
    processedCandidates: progress.processedCandidates ?? null,
    scannedCandidates: progress.scannedCandidates ?? null,
    passedCandidates: progress.passedCandidates ?? null,
    requestResumeSuccesses: progress.requestResumeSuccesses ?? null,
    llmCalls: progress.llmCalls ?? progress.recommendLlmCalls ?? progress.chatLlmCalls ?? null,
    actionClicks: progress.actionClicks ?? null,
    currentCandidateLabel: progress.currentCandidateLabel || "",
    lastItem: progress.lastItem || null
  };
}

function percentileSummary(values = []) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      count: 0,
      p50: null,
      p95: null,
      max: null
    };
  }
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1]
  };
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * ratio) - 1);
  return sortedValues[index];
}
