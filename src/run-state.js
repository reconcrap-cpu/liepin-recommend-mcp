import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { ARTIFACT_FILES, RUN_STATES, TERMINAL_RUN_STATES } from "./constants.js";
import { ensureRuntimeLayout } from "./config.js";
import {
  appendNdjsonLine,
  ensureDirSync,
  normalizeText,
  readJsonFile,
  toIsoNow,
  writeJsonFile
} from "./utils.js";

export function createRunId(kind = "run") {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${normalizeText(kind || "run") || "run"}-${timestamp}-${random}`;
}

export function getRunsDir(workspaceRoot) {
  return ensureRuntimeLayout(workspaceRoot).runsDir;
}

export function getRunDir(workspaceRoot, runId) {
  return path.join(getRunsDir(workspaceRoot), normalizeText(runId));
}

export function getRunArtifactPaths(workspaceRoot, runId) {
  const runDir = getRunDir(workspaceRoot, runId);
  return {
    runDir,
    runJsonPath: path.join(runDir, ARTIFACT_FILES.run),
    eventsPath: path.join(runDir, ARTIFACT_FILES.events),
    screenInputPath: path.join(runDir, ARTIFACT_FILES.screenInput),
    llmRequestPath: path.join(runDir, ARTIFACT_FILES.llmRequest),
    decisionPath: path.join(runDir, ARTIFACT_FILES.decision),
    coveragePath: path.join(runDir, ARTIFACT_FILES.coverage),
    reasoningPath: path.join(runDir, ARTIFACT_FILES.reasoning)
  };
}

export function createRunSnapshot({
  workspaceRoot,
  kind,
  input = {},
  phase = null,
  mode = "sample_only"
}) {
  const runId = createRunId(kind);
  const artifacts = getRunArtifactPaths(workspaceRoot, runId);
  const snapshot = {
    run_id: runId,
    kind,
    mode,
    phase,
    state: RUN_STATES.QUEUED,
    created_at: toIsoNow(),
    updated_at: toIsoNow(),
    started_at: null,
    finished_at: null,
    pid: null,
    workspace_root: path.resolve(workspaceRoot),
    input,
    stage: "queued",
    status_message: "Run created",
    progress: null,
    control: {
      pause_requested: false,
      cancel_requested: false
    },
    artifacts
  };
  initializeRunArtifacts(snapshot);
  return snapshot;
}

export function initializeRunArtifacts(snapshot) {
  const artifacts = snapshot.artifacts;
  ensureDirSync(artifacts.runDir);
  writeJsonFile(artifacts.screenInputPath, {});
  writeJsonFile(artifacts.llmRequestPath, {});
  writeJsonFile(artifacts.decisionPath, {});
  writeJsonFile(artifacts.coveragePath, {});
  writeRunState(snapshot);
  appendRunEvent(snapshot, "run_created", {
    kind: snapshot.kind,
    mode: snapshot.mode,
    phase: snapshot.phase
  });
  return snapshot;
}

export function writeRunState(snapshot) {
  const next = {
    ...snapshot,
    updated_at: toIsoNow()
  };
  writeJsonFile(snapshot.artifacts.runJsonPath, next);
  return next;
}

export function readRunState(workspaceRoot, runId) {
  const artifacts = getRunArtifactPaths(workspaceRoot, runId);
  return readJsonFile(artifacts.runJsonPath, null);
}

export function updateRunState(workspaceRoot, runId, patchOrUpdater) {
  const current = readRunState(workspaceRoot, runId);
  if (!current) return null;
  const patch = typeof patchOrUpdater === "function" ? patchOrUpdater(current) : patchOrUpdater;
  const next = {
    ...current,
    ...patch,
    control: {
      ...(current.control || {}),
      ...(patch?.control || {})
    },
    artifacts: current.artifacts
  };
  return writeRunState(next);
}

export function appendRunEvent(snapshotOrRun, type, payload = {}) {
  const artifacts = snapshotOrRun.artifacts
    ? snapshotOrRun.artifacts
    : getRunArtifactPaths(snapshotOrRun.workspace_root, snapshotOrRun.run_id);
  appendNdjsonLine(artifacts.eventsPath, {
    ts: toIsoNow(),
    type,
    payload
  });
}

export function listRuns(workspaceRoot) {
  const runsDir = getRunsDir(workspaceRoot);
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readRunState(workspaceRoot, entry.name))
    .filter(Boolean)
    .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
}

export function requestPause(workspaceRoot, runId) {
  return updateRunState(workspaceRoot, runId, {
    control: {
      pause_requested: true
    },
    status_message: "Pause requested"
  });
}

export function requestCancel(workspaceRoot, runId) {
  return updateRunState(workspaceRoot, runId, {
    control: {
      pause_requested: true,
      cancel_requested: true
    },
    status_message: "Cancel requested"
  });
}

export function clearPauseRequest(workspaceRoot, runId) {
  return updateRunState(workspaceRoot, runId, {
    control: {
      pause_requested: false
    }
  });
}

export function markRunRunning(workspaceRoot, runId, pid = process.pid) {
  return updateRunState(workspaceRoot, runId, {
    state: RUN_STATES.RUNNING,
    pid,
    started_at: toIsoNow(),
    stage: "running",
    status_message: "Run started"
  });
}

export function updateRunProgress(workspaceRoot, runId, {
  stage,
  statusMessage,
  progress,
  eventType = "run_progress"
} = {}) {
  const patch = {};
  if (stage !== undefined) patch.stage = stage;
  if (statusMessage !== undefined) patch.status_message = statusMessage;
  if (progress !== undefined) patch.progress = progress;

  const next = updateRunState(workspaceRoot, runId, patch);
  if (next && eventType) {
    appendRunEvent(next, eventType, {
      stage: next.stage || "",
      status_message: next.status_message || "",
      progress: next.progress || null
    });
  }
  return next;
}

export function markRunCompleted(workspaceRoot, runId, result = {}) {
  const artifactSummary = persistRunWorkflowArtifacts(workspaceRoot, runId, result);
  const next = updateRunState(workspaceRoot, runId, {
    state: RUN_STATES.COMPLETED,
    finished_at: toIsoNow(),
    stage: "completed",
    status_message: "Run completed",
    artifact_summary: artifactSummary,
    result
  });
  if (next) appendRunEvent(next, "run_completed", result);
  return next;
}

export function markRunFailed(workspaceRoot, runId, error, { workflowResult = null } = {}) {
  const normalizedWorkflowResult = normalizeWorkflowResultForTerminalState(workflowResult, RUN_STATES.FAILED);
  const artifactSummary = normalizedWorkflowResult
    ? persistRunWorkflowArtifacts(workspaceRoot, runId, normalizedWorkflowResult)
    : null;
  const patch = {
    state: RUN_STATES.FAILED,
    finished_at: toIsoNow(),
    stage: "failed",
    status_message: error?.message || "Run failed",
    error
  };
  if (artifactSummary) patch.artifact_summary = artifactSummary;
  if (normalizedWorkflowResult) patch.result = normalizedWorkflowResult;
  const next = updateRunState(workspaceRoot, runId, patch);
  if (next) appendRunEvent(next, "run_failed", error);
  return next;
}

export function markRunPaused(workspaceRoot, runId, result = null) {
  const normalizedWorkflowResult = normalizeWorkflowResultForTerminalState(
    isWorkflowResultLike(result) ? result : null,
    RUN_STATES.PAUSED
  );
  const artifactSummary = normalizedWorkflowResult
    ? persistRunWorkflowArtifacts(workspaceRoot, runId, normalizedWorkflowResult)
    : null;
  const patch = {
    state: RUN_STATES.PAUSED,
    stage: "paused",
    status_message: "Run paused",
    result: result || undefined
  };
  if (artifactSummary) patch.artifact_summary = artifactSummary;
  if (normalizedWorkflowResult) patch.result = normalizedWorkflowResult;
  const next = updateRunState(workspaceRoot, runId, patch);
  if (next) appendRunEvent(next, "run_paused", result || {});
  return next;
}

export function markRunCanceled(workspaceRoot, runId, result = null) {
  const normalizedWorkflowResult = normalizeWorkflowResultForTerminalState(
    isWorkflowResultLike(result) ? result : null,
    RUN_STATES.CANCELED
  );
  const artifactSummary = normalizedWorkflowResult
    ? persistRunWorkflowArtifacts(workspaceRoot, runId, normalizedWorkflowResult)
    : null;
  const patch = {
    state: RUN_STATES.CANCELED,
    finished_at: toIsoNow(),
    stage: "canceled",
    status_message: "Run canceled",
    result: result || undefined
  };
  if (artifactSummary) patch.artifact_summary = artifactSummary;
  if (normalizedWorkflowResult) patch.result = normalizedWorkflowResult;
  const next = updateRunState(workspaceRoot, runId, patch);
  if (next) appendRunEvent(next, "run_canceled", result || {});
  return next;
}

export function isRunTerminal(snapshot) {
  return TERMINAL_RUN_STATES.has(snapshot?.state);
}

export function summarizeRun(snapshot = {}) {
  return {
    run_id: snapshot.run_id || "",
    kind: snapshot.kind || "",
    mode: snapshot.mode || "",
    phase: snapshot.phase || null,
    workflow: snapshot.input?.workflow || snapshot.result?.workflow || "",
    state: snapshot.state || "",
    stage: snapshot.stage || "",
    status_message: snapshot.status_message || "",
    created_at: snapshot.created_at || null,
    updated_at: snapshot.updated_at || null,
    started_at: snapshot.started_at || null,
    finished_at: snapshot.finished_at || null,
    pid: snapshot.pid || null,
    control: snapshot.control || {},
    input: snapshot.input || {},
    summary: snapshot.result?.summary || null,
    progress: snapshot.progress || null,
    artifact_summary: snapshot.artifact_summary || null,
    artifacts: snapshot.artifacts || null,
    error: snapshot.error || null
  };
}

export function buildRunStatusPayload(snapshot, { full = false } = {}) {
  if (!snapshot) return null;
  return full ? snapshot : summarizeRun(snapshot);
}

export function persistRunWorkflowArtifacts(workspaceRoot, runId, workflowResult = {}) {
  const artifacts = getRunArtifactPaths(workspaceRoot, runId);
  const payloads = buildWorkflowArtifactPayloads(workflowResult);
  writeJsonFile(artifacts.screenInputPath, payloads.screenInput);
  writeJsonFile(artifacts.llmRequestPath, payloads.llmRequest);
  writeJsonFile(artifacts.decisionPath, payloads.decision);
  writeJsonFile(artifacts.coveragePath, payloads.coverage);
  return {
    screenInputPath: artifacts.screenInputPath,
    llmRequestPath: artifacts.llmRequestPath,
    decisionPath: artifacts.decisionPath,
    coveragePath: artifacts.coveragePath,
    itemCount: payloads.itemCount,
    workflow: payloads.workflow
  };
}

export function buildWorkflowArtifactPayloads(workflowResult = {}) {
  const workflow = workflowResult.workflow || workflowResult.result?.workflow || "";
  const summary = workflowResult.summary || workflowResult.result?.summary || null;
  const detail = workflowResult.result || workflowResult;
  const items = Array.isArray(detail.items) ? detail.items : [];
  return {
    workflow,
    itemCount: items.length,
    screenInput: {
      workflow,
      itemCount: items.length,
      items: items.map((item) => ({
        index: item.index ?? item.rowIndex ?? null,
        rowKey: item.rowKey || item.chatState?.rowKey || item.candidate?.resumeId || "",
        candidateLabel: item.candidateLabel || item.candidate?.name || item.candidate?.label || item.beforeState?.rowText || item.rowText || "",
        textHash: item.textHash || item.candidate?.textHash || "",
        manifest: item.manifest || item.inputManifest || item.chatInputManifest || item.recommendInputManifest || null,
        inputManifest: item.inputManifest || null,
        recommendInputManifest: item.recommendInputManifest || null,
        chatInputManifest: item.chatInputManifest || null
      }))
    },
    llmRequest: {
      workflow,
      itemCount: items.length,
      requests: items.map((item) => ({
        index: item.index ?? item.rowIndex ?? null,
        rowKey: item.rowKey || item.chatState?.rowKey || item.candidate?.resumeId || "",
        llmRequest: item.llmRequest || null,
        recommendLlmRequest: item.recommendLlmRequest || null,
        chatLlmRequest: item.chatLlmRequest || null
      }))
    },
    decision: {
      workflow,
      summary,
      itemCount: items.length,
      decisions: items.map((item) => ({
        index: item.index ?? item.rowIndex ?? null,
        rowKey: item.rowKey || item.chatState?.rowKey || item.candidate?.resumeId || "",
        status: item.status || "",
        decision: item.decision || null,
        recommendDecision: item.recommendDecision || null,
        chatDecision: item.chatDecision || null,
        wouldPostAction: item.wouldPostAction
          || item.decision?.post_action
          || item.recommendDecision?.post_action
          || item.chatDecision?.post_action
          || null,
        actionExecuted: Boolean(item.actionExecuted || item.chatAction?.executed),
        actionClicked: Boolean(item.clicked || item.chatAction?.clicked || item.recommendChatAction?.clicked)
      }))
    },
    coverage: {
      workflow,
      summary,
      itemCount: items.length,
      coverage: items.map((item) => ({
        index: item.index ?? item.rowIndex ?? null,
        rowKey: item.rowKey || item.chatState?.rowKey || item.candidate?.resumeId || "",
        coverage: item.coverage || null,
        recommendCoverage: item.recommendCoverage || null,
        missingRequiredSourceIds: item.missingRequiredSourceIds || item.chatInputManifest?.missingRequiredSourceIds || []
      }))
    }
  };
}

function isWorkflowResultLike(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  return Boolean(
    value.workflow
    || value.summary
    || value.result
    || value.schemaVersion
    || value.items
  );
}

function normalizeWorkflowResultForTerminalState(workflowResult, state) {
  if (!isWorkflowResultLike(workflowResult)) return null;
  const workflow = normalizeText(workflowResult.workflow || workflowResult.result?.workflow || "");
  const result = normalizeResultPayload(workflowResult);
  const summary = {
    ...(workflowResult.summary && typeof workflowResult.summary === "object" ? workflowResult.summary : {})
  };
  if (!Object.hasOwn(summary, "ok")) {
    summary.ok = state === RUN_STATES.COMPLETED;
  }
  if (!Object.hasOwn(summary, "terminalState")) {
    summary.terminalState = state;
  }
  return {
    workflow,
    summary,
    result
  };
}

function normalizeResultPayload(workflowResult) {
  if (workflowResult?.result && typeof workflowResult.result === "object") {
    return workflowResult.result;
  }
  if (workflowResult && typeof workflowResult === "object") {
    return workflowResult;
  }
  return {};
}
