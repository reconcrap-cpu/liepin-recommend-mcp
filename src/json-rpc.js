import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_DEBUG_PORT,
  RUN_KINDS,
  RUN_WORKFLOWS,
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_NAMES
} from "./constants.js";
import { getWorkspaceRoot } from "./config.js";
import { runDoctor } from "./doctor.js";
import {
  exportExternalAgentConfig,
  exportSkill,
  runInstall,
  runSelfHeal
} from "./platform.js";
import { runProviderCheck } from "./provider-check.js";
import {
  buildRunStatusPayload,
  clearPauseRequest,
  createRunSnapshot,
  isRunTerminal,
  readRunState,
  requestCancel,
  requestPause
} from "./run-state.js";

function createToolResult(id, payload, isError = false) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2)
        }
      ],
      isError
    }
  };
}

function createError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message
    }
  };
}

function createTools() {
  return [
    {
      name: TOOL_NAMES.doctor,
      description: "Run liepin environment checks for config, Chrome 9222, and page discovery.",
      inputSchema: {
        type: "object",
        properties: {
          debug_port: { type: "integer", minimum: 1 },
          fix: { type: "boolean" },
          provider_check: { type: "boolean" }
        },
        additionalProperties: false
      }
    },
    {
      name: TOOL_NAMES.install,
      description: "Initialize runtime layout, optional screening config template, and external agent config.",
      inputSchema: {
        type: "object",
        properties: {
          write_config_template: { type: "boolean" },
          overwrite_config_template: { type: "boolean" },
          export_external_config: { type: "boolean" },
          external_config_path: { type: "string" },
          agent: { type: "string" }
        },
        additionalProperties: false
      }
    },
    {
      name: TOOL_NAMES.selfHeal,
      description: "Run install+self-heal checks and optional provider readiness verification.",
      inputSchema: {
        type: "object",
        properties: {
          debug_port: { type: "integer", minimum: 1 },
          provider_check: { type: "boolean" },
          export_external_config: { type: "boolean" },
          external_config_path: { type: "string" },
          agent: { type: "string" }
        },
        additionalProperties: false
      }
    },
    {
      name: TOOL_NAMES.skillExport,
      description: "Export reusable skill guidance for external agent operators.",
      inputSchema: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["markdown", "json"]
          },
          output_path: { type: "string" }
        },
        additionalProperties: false
      }
    },
    {
      name: TOOL_NAMES.externalAgentConfig,
      description: "Export an external agent MCP config for this workspace.",
      inputSchema: {
        type: "object",
        properties: {
          output_path: { type: "string" }
        },
        additionalProperties: false
      }
    },
    {
      name: TOOL_NAMES.providerCheck,
      description: "Check OpenAI-compatible screening provider readiness with synthetic recommend/chat inputs.",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["both", "recommend", "chat"]
          }
        },
        additionalProperties: false
      }
    },
    ...Object.entries({
      [TOOL_NAMES.recommendStart]: RUN_KINDS.RECOMMEND,
      [TOOL_NAMES.chatStart]: RUN_KINDS.CHAT,
      [TOOL_NAMES.recommendChatStart]: RUN_KINDS.RECOMMEND_CHAT
    }).map(([name]) => ({
      name,
      description: `Create an async ${name} run in the current implementation stage.`,
      inputSchema: {
        type: "object",
        properties: {
          debug_port: { type: "integer", minimum: 1 },
          sample_limit: { type: "integer", minimum: 1 },
          candidate_limit: { type: "integer", minimum: 1 },
          scan_limit: { type: "integer", minimum: 1 },
          row_limit: { type: "integer", minimum: 1 },
          max_scroll_passes: { type: "integer", minimum: 1 },
          tab: { type: "string" },
          filter: { type: "string" },
          start_index: { type: "integer", minimum: 0 },
          step_delay_ms: { type: "integer", minimum: 1 },
          chat_entry_timeout_ms: { type: "integer", minimum: 1 },
          max_chars: { type: "integer", minimum: 1 },
          minimum_samples: { type: "integer", minimum: 1 },
          batch_size: { type: "integer", minimum: 1 },
          workflow: {
            type: "string",
            enum: Object.values(RUN_WORKFLOWS)
          },
          mock_llm: { type: "boolean" },
          mock_model: { type: "string" },
          mock_decision: { type: "string" },
          mock_post_action: { type: "string" },
          mock_recommend_decision: { type: "string" },
          mock_recommend_post_action: { type: "string" },
          mock_chat_decision: { type: "string" },
          mock_chat_post_action: { type: "string" },
          execute_request_resume: { type: "boolean" },
          allow_chat_action: { type: "boolean" },
          allow_request_resume: { type: "boolean" }
        },
        additionalProperties: false
      }
    })),
    ...[
      TOOL_NAMES.runStatus,
      TOOL_NAMES.runPause,
      TOOL_NAMES.runResume,
      TOOL_NAMES.runCancel
    ].map((name) => ({
      name,
      description: `${name} by run_id`,
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string" }
        },
        required: ["run_id"],
        additionalProperties: false
      }
    }))
  ];
}

export async function handleJsonRpc(message, workspaceRoot = getWorkspaceRoot()) {
  if (!message || message.jsonrpc !== "2.0") {
    return createError(null, -32600, "Invalid JSON-RPC request");
  }
  const { id, method, params } = message;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION
        }
      }
    };
  }
  if (method === "notifications/initialized") return null;
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: createTools()
      }
    };
  }
  if (method === "ping") {
    return {
      jsonrpc: "2.0",
      id,
      result: {}
    };
  }
  if (method !== "tools/call") {
    return createError(id, -32601, `Method not found: ${method}`);
  }

  const toolName = params?.name;
  const args = params?.arguments || {};
  try {
    if (toolName === TOOL_NAMES.doctor) {
      const payload = await runDoctor({
        workspaceRoot,
        port: args.debug_port || DEFAULT_DEBUG_PORT,
        fix: Boolean(args.fix),
        providerCheck: Boolean(args.provider_check)
      });
      return createToolResult(id, payload, !payload.ok);
    }

    if (toolName === TOOL_NAMES.install) {
      const payload = runInstall({
        workspaceRoot,
        writeConfigTemplate: args.write_config_template ?? true,
        overwriteConfigTemplate: Boolean(args.overwrite_config_template),
        exportExternalConfig: args.export_external_config ?? true,
        externalConfigPath: args.external_config_path || null,
        agent: args.agent || null
      });
      return createToolResult(id, payload, !payload.ok);
    }

    if (toolName === TOOL_NAMES.selfHeal) {
      const payload = await runSelfHeal({
        workspaceRoot,
        port: args.debug_port || DEFAULT_DEBUG_PORT,
        providerCheck: Boolean(args.provider_check),
        exportExternalConfig: args.export_external_config ?? true,
        externalConfigPath: args.external_config_path || null,
        agent: args.agent || null
      });
      return createToolResult(id, payload, !payload.ok);
    }

    if (toolName === TOOL_NAMES.skillExport) {
      const payload = exportSkill({
        workspaceRoot,
        format: args.format || "markdown",
        outputPath: args.output_path || null
      });
      return createToolResult(id, payload, !payload.ok);
    }

    if (toolName === TOOL_NAMES.externalAgentConfig) {
      const payload = exportExternalAgentConfig({
        workspaceRoot,
        outputPath: args.output_path || null
      });
      return createToolResult(id, payload, !payload.ok);
    }

    if (toolName === TOOL_NAMES.providerCheck) {
      const payload = await runProviderCheck({
        workspaceRoot,
        mode: args.mode || "both"
      });
      return createToolResult(id, payload, !payload.ok);
    }

    if (toolName === TOOL_NAMES.runStatus) {
      const run = readRunState(workspaceRoot, args.run_id);
      return createToolResult(id, run
        ? { status: "RUN_STATUS", run: buildRunStatusPayload(run) }
        : { status: "FAILED", error: { code: "RUN_NOT_FOUND", message: `未找到 run_id=${args.run_id}` } }, !run);
    }

    if (toolName === TOOL_NAMES.runPause) {
      const run = requestPause(workspaceRoot, args.run_id);
      return createToolResult(id, run
        ? { status: "PAUSE_REQUESTED", run }
        : { status: "FAILED", error: { code: "RUN_NOT_FOUND", message: `未找到 run_id=${args.run_id}` } }, !run);
    }

    if (toolName === TOOL_NAMES.runCancel) {
      const run = requestCancel(workspaceRoot, args.run_id);
      return createToolResult(id, run
        ? { status: "CANCEL_REQUESTED", run }
        : { status: "FAILED", error: { code: "RUN_NOT_FOUND", message: `未找到 run_id=${args.run_id}` } }, !run);
    }

    if (toolName === TOOL_NAMES.runResume) {
      const current = readRunState(workspaceRoot, args.run_id);
      if (!current) {
        return createToolResult(id, {
          status: "FAILED",
          error: {
            code: "RUN_NOT_FOUND",
            message: `未找到 run_id=${args.run_id}`
          }
        }, true);
      }
      if (isRunTerminal(current)) {
        return createToolResult(id, {
          status: "FAILED",
          error: {
            code: "RUN_TERMINAL",
            message: `run_id=${args.run_id} 已结束，不能 resume。`
          },
          run: current
        }, true);
      }
      clearPauseRequest(workspaceRoot, args.run_id);
      const worker = spawnRunWorker({
        workspaceRoot,
        runId: args.run_id
      });
      return createToolResult(id, {
        status: "RESUME_REQUESTED",
        run_id: args.run_id,
        pid: worker.pid
      });
    }

    const kind = {
      [TOOL_NAMES.recommendStart]: RUN_KINDS.RECOMMEND,
      [TOOL_NAMES.chatStart]: RUN_KINDS.CHAT,
      [TOOL_NAMES.recommendChatStart]: RUN_KINDS.RECOMMEND_CHAT
    }[toolName];
    if (kind) {
      const input = buildStartInput(kind, args);
      assertSideEffectApproval(input);
      const snapshot = createRunSnapshot({
        workspaceRoot,
        kind,
        mode: "async_workflow",
        phase: "P29",
        input
      });
      const worker = spawnRunWorker({
        workspaceRoot,
        runId: snapshot.run_id
      });
      return createToolResult(id, {
        status: "ACCEPTED",
        run_id: snapshot.run_id,
        pid: worker.pid,
        state: "queued",
        workflow: input.workflow
      });
    }

    return createError(id, -32602, `Unknown tool: ${toolName || ""}`);
  } catch (error) {
    return createToolResult(id, {
      status: "FAILED",
      error: {
        code: error?.code || "UNEXPECTED_ERROR",
        message: error?.message || "Unexpected error"
      }
    }, true);
  }
}

function buildStartInput(kind, args = {}) {
  const base = {
    ...args,
    debug_port: args.debug_port || DEFAULT_DEBUG_PORT,
    mock_llm: Boolean(args.mock_llm)
  };
  if (kind === RUN_KINDS.RECOMMEND) {
    return {
      ...base,
      workflow: args.workflow || RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
      candidate_limit: args.candidate_limit || args.sample_limit || 20,
      tab: args.tab || "推荐",
      mock_decision: args.mock_decision || "fail",
      mock_post_action: args.mock_post_action || "none"
    };
  }
  if (kind === RUN_KINDS.CHAT) {
    return {
      ...base,
      workflow: args.workflow || RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING,
      candidate_limit: args.candidate_limit || args.sample_limit || 20,
      row_limit: args.row_limit || 40,
      max_scroll_passes: args.max_scroll_passes || 3,
      filter: args.filter || "有简历",
      mock_decision: args.mock_decision || "fail",
      mock_post_action: args.mock_post_action || "none"
    };
  }
  return {
    ...base,
    workflow: args.workflow || RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
    candidate_limit: args.candidate_limit || 5,
    tab: args.tab || "推荐",
    start_index: args.start_index || 0,
    step_delay_ms: args.step_delay_ms || 3500,
    chat_entry_timeout_ms: args.chat_entry_timeout_ms || 30000,
    mock_recommend_decision: args.mock_recommend_decision || args.mock_decision || "pass",
    mock_recommend_post_action: args.mock_recommend_post_action || args.mock_post_action || "chat",
    mock_chat_decision: args.mock_chat_decision || args.mock_decision || "pass",
    mock_chat_post_action: args.mock_chat_post_action || "request_resume",
    execute_request_resume: Boolean(args.execute_request_resume),
    allow_chat_action: Boolean(args.allow_chat_action),
    allow_request_resume: Boolean(args.allow_request_resume)
  };
}

function assertSideEffectApproval(input = {}) {
  if (input.workflow === RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN && !input.allow_chat_action) {
    throw createSideEffectError(
      "recommend_chat_chain 会点击推荐沟通按钮；请显式传入 allow_chat_action。"
    );
  }
  if (input.execute_request_resume && !input.allow_request_resume) {
    throw createSideEffectError(
      "execute_request_resume 会真实索要简历；请显式传入 allow_request_resume。"
    );
  }
}

function createSideEffectError(message) {
  const error = new Error(message);
  error.code = "SIDE_EFFECT_APPROVAL_REQUIRED";
  return error;
}

function spawnRunWorker({ workspaceRoot, runId }) {
  const child = spawn(
    process.execPath,
    [
      path.join(workspaceRoot, "src", "worker.js"),
      "--run-id",
      runId,
      "--workspace-root",
      workspaceRoot
    ],
    {
      cwd: workspaceRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  child.unref();
  return child;
}

export function createLineFramedServer() {
  const workspaceRoot = getWorkspaceRoot();
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", async (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify(createError(null, -32700, "Parse error"))}\n`);
        continue;
      }
      const response = await handleJsonRpc(message, workspaceRoot);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
}
