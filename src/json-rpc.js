import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_DEBUG_PORT,
  RUN_KINDS,
  RUN_WORKFLOWS,
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_NAMES
} from "./constants.js";
import { getWorkspaceRoot, resolveDefaultDebugPort } from "./config.js";
import { runDoctor } from "./doctor.js";
import {
  exportExternalAgentConfig,
  exportSkill,
  runInstall,
  runSelfHeal
} from "./platform.js";
import { runProviderCheck } from "./provider-check.js";
import {
  discoverRecommendFilters,
  summarizeRecommendFilterDiscovery
} from "./liepin/recommend-filter-discovery.js";
import { describeRecommendFilterOptions } from "./liepin/recommend-filter-executor.js";
import {
  discoverSearchOptions,
  summarizeSearchOptions
} from "./liepin/search-options.js";
import {
  buildRunStatusPayload,
  clearPauseRequest,
  createRunSnapshot,
  isRunTerminal,
  readRunState,
  requestCancel,
  requestPause
} from "./run-state.js";
import { parsePositiveInteger } from "./utils.js";

const currentFilePath = fileURLToPath(import.meta.url);
const workerScriptPath = path.join(path.dirname(currentFilePath), "worker.js");

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
      description: "Run liepin environment checks for config, configured Chrome debug port, and page discovery.",
      inputSchema: {
        type: "object",
        properties: {
          debug_port: { type: "integer", minimum: 1 },
          fix: { type: "boolean" },
          provider_check: { type: "boolean" },
          require_chat_page: { type: "boolean" }
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
          require_chat_page: { type: "boolean" },
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
    {
      name: TOOL_NAMES.recommendFilterOptions,
      description: [
        "List available Liepin recommend-page filter fields and options for the operator.",
        "Call this before asking the user for the `filter` argument of a recommend/recommend-chat start task.",
        "The `filter` argument is page filter conditions, not LLM screening criteria."
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          debug_port: { type: "integer", minimum: 1 },
          verify: { type: "boolean" }
        },
        additionalProperties: false
      }
    },
    {
      name: TOOL_NAMES.searchOptions,
      description: [
        "List available Liepin search-page quick search profiles and job choices for the operator.",
        "Call this before asking the user for liepin_search_start `profile` and `job`.",
        "The tool also reports checked job conditions in the selected-job dropdown so operators can verify the search workflow will clear them before scanning."
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          debug_port: { type: "integer", minimum: 1 },
          open_job_dropdown: { type: "boolean" }
        },
        additionalProperties: false
      }
    },
    ...Object.entries({
      [TOOL_NAMES.recommendStart]: RUN_KINDS.RECOMMEND,
      [TOOL_NAMES.searchStart]: RUN_KINDS.SEARCH,
      [TOOL_NAMES.chatStart]: RUN_KINDS.CHAT,
      [TOOL_NAMES.recommendChatStart]: RUN_KINDS.RECOMMEND_CHAT
    }).map(([name]) => ({
      name,
      description: [
        `Create an async ${name} run in the current implementation stage.`,
        "`candidate_limit` means the target number of candidates that pass screening, not the number scanned or processed.",
        "`filter` means Liepin page filter conditions. Before starting, ask the user to choose from liepin_recommend_filter_options; pass JSON or natural language such as 学历=本科、硕士; 年龄=22-30; 院校=985、211. Use 沿用页面当前筛选 only when the user explicitly wants current page filters.",
        "Production chat/request-resume actions default to enabled; do not ask for an extra real-operation confirmation unless the user asks to disable actions."
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          debug_port: { type: "integer", minimum: 1 },
          sample_limit: { type: "integer", minimum: 1 },
          candidate_limit: {
            type: "integer",
            minimum: 1,
            description: "Target number of candidates that pass screening."
          },
          scan_limit: {
            type: "integer",
            minimum: 1,
            description: "Optional maximum candidates to scan while trying to reach candidate_limit passed candidates."
          },
          row_limit: { type: "integer", minimum: 1 },
          max_scroll_passes: { type: "integer", minimum: 1 },
          tab: { type: "string" },
          filter: {
            type: "string",
            description: "Liepin page filters, not screening criteria. Supports JSON or natural language. Examples: 沿用页面当前筛选; 学历=本科、硕士; 年龄=22-30; 院校=985、211."
          },
          profile: {
            type: "string",
            description: "Liepin search quick-search profile title. Call liepin_search_options first and pass one of its profiles."
          },
          search_profile: { type: "string" },
          job: {
            type: "string",
            description: "Liepin job title for search page selected-job cleanup and the communication job modal. Call liepin_search_options first and pass one of its jobs."
          },
          job_title: { type: "string" },
          criteria: { type: "string" },
          recommend_criteria: { type: "string" },
          chat_criteria: { type: "string" },
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

export async function handleJsonRpc(message, workspaceRoot = getWorkspaceRoot(), {
  spawnWorker = spawnRunWorker
} = {}) {
  const defaultDebugPort = resolveDefaultDebugPort(workspaceRoot);
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
        port: parsePositiveInteger(args.debug_port, defaultDebugPort),
        fix: Boolean(args.fix),
        providerCheck: Boolean(args.provider_check),
        requireChatPage: Boolean(args.require_chat_page)
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
        port: parsePositiveInteger(args.debug_port, defaultDebugPort),
        providerCheck: Boolean(args.provider_check),
        requireChatPage: Boolean(args.require_chat_page),
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

    if (toolName === TOOL_NAMES.recommendFilterOptions) {
      const discovery = await discoverRecommendFilters({
        port: parsePositiveInteger(args.debug_port, defaultDebugPort)
      }, {
        verify: args.verify ?? false
      });
      const payload = {
        status: "OK",
        summary: summarizeRecommendFilterDiscovery(discovery),
        filterUsage: {
          currentPageFilterLabel: "沿用页面当前筛选",
          examples: [
            "学历=本科、硕士; 年龄=22-30; 院校=985、211",
            "{\"education\":[\"本科\",\"硕士\"],\"age\":{\"min\":22,\"max\":30},\"school_tier\":[\"985\",\"211\"]}"
          ]
        },
        filters: describeRecommendFilterOptions(discovery.filters),
        discovery
      };
      return createToolResult(id, payload, !discovery.passed && args.verify === true);
    }

    if (toolName === TOOL_NAMES.searchOptions) {
      const discovery = await discoverSearchOptions({
        port: parsePositiveInteger(args.debug_port, defaultDebugPort)
      }, {
        openJobDropdown: args.open_job_dropdown ?? true
      });
      const payload = {
        status: "OK",
        summary: summarizeSearchOptions(discovery),
        searchUsage: {
          requiredStartArgs: ["profile", "job", "criteria", "candidate_limit"],
          profileSource: "profiles[].title",
          jobSource: "jobs[].title",
          note: "search_start 会先选择 job 并清空职位下拉里的 checked 条件，再点击 profile 开始扫描。"
        },
        profiles: discovery.profiles,
        jobs: discovery.jobs,
        checkedJobConditions: discovery.checkedJobConditions,
        discovery
      };
      return createToolResult(id, payload, !discovery.passed);
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
      const worker = spawnWorker({
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
      [TOOL_NAMES.searchStart]: RUN_KINDS.SEARCH,
      [TOOL_NAMES.chatStart]: RUN_KINDS.CHAT,
      [TOOL_NAMES.recommendChatStart]: RUN_KINDS.RECOMMEND_CHAT
    }[toolName];
    if (kind) {
      const input = buildStartInput(kind, args, defaultDebugPort);
      assertSideEffectApproval(input);
      const snapshot = createRunSnapshot({
        workspaceRoot,
        kind,
        mode: "async_workflow",
        phase: "P29",
        input
      });
      const worker = spawnWorker({
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

function buildStartInput(kind, args = {}, defaultDebugPort = DEFAULT_DEBUG_PORT) {
  const base = {
    ...args,
    debug_port: parsePositiveInteger(args.debug_port, defaultDebugPort),
    mock_llm: Boolean(args.mock_llm),
    criteria: args.criteria || null
  };
  if (kind === RUN_KINDS.RECOMMEND) {
    return {
      ...base,
      workflow: args.workflow || RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
      candidate_limit: args.candidate_limit || args.sample_limit || 20,
      scan_limit: args.scan_limit || null,
      tab: args.tab || "推荐",
      start_index: args.start_index || 0,
      step_delay_ms: args.step_delay_ms || 3500,
      chat_entry_timeout_ms: args.chat_entry_timeout_ms || 30000,
      filter: args.filter || null,
      recommend_criteria: args.recommend_criteria || args.criteria || null,
      chat_criteria: args.chat_criteria || args.criteria || null,
      mock_decision: args.mock_decision || "fail",
      mock_post_action: args.mock_post_action || "none",
      mock_recommend_decision: args.mock_recommend_decision || args.mock_decision || "pass",
      mock_recommend_post_action: args.mock_recommend_post_action || args.mock_post_action || "chat",
      mock_chat_decision: args.mock_chat_decision || args.mock_decision || "pass",
      mock_chat_post_action: args.mock_chat_post_action || "request_resume",
      execute_request_resume: args.execute_request_resume === undefined
        ? true
        : Boolean(args.execute_request_resume),
      allow_chat_action: args.allow_chat_action === undefined
        ? true
        : Boolean(args.allow_chat_action),
      allow_request_resume: args.allow_request_resume === undefined
        ? true
        : Boolean(args.allow_request_resume)
    };
  }
  if (kind === RUN_KINDS.CHAT) {
    return {
      ...base,
      workflow: args.workflow || RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
      candidate_limit: args.candidate_limit || args.sample_limit || 20,
      scan_limit: args.scan_limit || null,
      tab: args.tab || "推荐",
      start_index: args.start_index || 0,
      step_delay_ms: args.step_delay_ms || 3500,
      chat_entry_timeout_ms: args.chat_entry_timeout_ms || 30000,
      row_limit: args.row_limit || 40,
      max_scroll_passes: args.max_scroll_passes || 3,
      filter: args.filter || null,
      recommend_criteria: args.recommend_criteria || args.criteria || null,
      chat_criteria: args.chat_criteria || args.criteria || null,
      mock_decision: args.mock_decision || "fail",
      mock_post_action: args.mock_post_action || "none",
      mock_recommend_decision: args.mock_recommend_decision || args.mock_decision || "pass",
      mock_recommend_post_action: args.mock_recommend_post_action || args.mock_post_action || "chat",
      mock_chat_decision: args.mock_chat_decision || args.mock_decision || "pass",
      mock_chat_post_action: args.mock_chat_post_action || "request_resume",
      execute_request_resume: args.execute_request_resume === undefined
        ? true
        : Boolean(args.execute_request_resume),
      allow_chat_action: args.allow_chat_action === undefined
        ? true
        : Boolean(args.allow_chat_action),
      allow_request_resume: args.allow_request_resume === undefined
        ? true
        : Boolean(args.allow_request_resume)
    };
  }
  if (kind === RUN_KINDS.SEARCH) {
    return {
      ...base,
      workflow: args.workflow || RUN_WORKFLOWS.SEARCH_CHAT_CHAIN,
      profile: args.profile || args.search_profile || null,
      job: args.job || args.job_title || null,
      candidate_limit: args.candidate_limit || args.sample_limit || 5,
      scan_limit: args.scan_limit || null,
      start_index: args.start_index || 0,
      step_delay_ms: args.step_delay_ms || 3500,
      max_chars: args.max_chars || null,
      filter: args.filter || null,
      criteria: args.criteria || args.recommend_criteria || null,
      mock_decision: args.mock_decision || args.mock_recommend_decision || "pass",
      mock_post_action: args.mock_post_action || args.mock_recommend_post_action || "chat",
      mock_recommend_decision: args.mock_recommend_decision || args.mock_decision || "pass",
      mock_recommend_post_action: args.mock_recommend_post_action || args.mock_post_action || "chat",
      execute_request_resume: false,
      allow_chat_action: args.allow_chat_action === undefined
        ? true
        : Boolean(args.allow_chat_action),
      allow_request_resume: false
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
    filter: args.filter || null,
    recommend_criteria: args.recommend_criteria || args.criteria || null,
    chat_criteria: args.chat_criteria || args.criteria || null,
    mock_recommend_decision: args.mock_recommend_decision || args.mock_decision || "pass",
    mock_recommend_post_action: args.mock_recommend_post_action || args.mock_post_action || "chat",
    mock_chat_decision: args.mock_chat_decision || args.mock_decision || "pass",
    mock_chat_post_action: args.mock_chat_post_action || "request_resume",
    execute_request_resume: args.execute_request_resume === undefined
      ? true
      : Boolean(args.execute_request_resume),
    allow_chat_action: args.allow_chat_action === undefined
      ? true
      : Boolean(args.allow_chat_action),
    allow_request_resume: args.allow_request_resume === undefined
      ? true
      : Boolean(args.allow_request_resume)
  };
}

function assertSideEffectApproval(input = {}) {
  if (input.workflow === RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN && !input.allow_chat_action) {
    throw createSideEffectError(
      "recommend_chat_chain 会点击推荐沟通按钮；请显式传入 allow_chat_action。"
    );
  }
  if (input.workflow === RUN_WORKFLOWS.SEARCH_CHAT_CHAIN && !input.allow_chat_action) {
    throw createSideEffectError(
      "search_chat_chain 会点击搜索页立即沟通按钮；请显式传入 allow_chat_action。"
    );
  }
  if (
    input.workflow === RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN
    && input.execute_request_resume
    && !input.allow_request_resume
  ) {
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
      workerScriptPath,
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
