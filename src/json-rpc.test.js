import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { handleJsonRpc } from "./json-rpc.js";
import { ENV_HOME, RUN_KINDS, RUN_WORKFLOWS, TOOL_NAMES } from "./constants.js";
import { createRunSnapshot, markRunCompleted, readRunState, updateRunProgress } from "./run-state.js";

const stubWorker = () => ({ pid: 12345 });
const okDoctor = async (options = {}) => ({
  ok: true,
  targetPage: options.targetPage || (options.requireChatPage ? "chat" : "recommend"),
  checks: [],
  recommendations: [],
  fixes: []
});

test("tools/list exposes liepin-prefixed tools", async () => {
  const response = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list"
  }, process.cwd(), { spawnWorker: stubWorker });
  assert.equal(response.result.tools.some((tool) => tool.name === "liepin_doctor"), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.install), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.selfHeal), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.skillExport), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.externalAgentConfig), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.providerCheck), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.recommendFilterOptions), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.searchOptions), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.chatOptions), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.searchStart), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.runProgress), true);
  const doctorTool = response.result.tools.find((tool) => tool.name === TOOL_NAMES.doctor);
  assert.deepEqual(doctorTool.inputSchema.properties.target_page.enum, ["recommend", "search", "chat"]);
  const recommendChatTool = response.result.tools.find((tool) => tool.name === TOOL_NAMES.recommendChatStart);
  assert.equal(recommendChatTool.inputSchema.properties.allow_chat_action.type, "boolean");
  assert.equal(recommendChatTool.inputSchema.properties.allow_request_resume.type, "boolean");
  assert.equal(recommendChatTool.inputSchema.properties.candidate_limit.description.includes("pass"), true);
  assert.equal(
    response.result.tools
      .find((tool) => tool.name === TOOL_NAMES.recommendStart)
      .inputSchema.properties.workflow.enum.includes(RUN_WORKFLOWS.CHAT_SCREENING),
    false
  );
  assert.deepEqual(
    response.result.tools.find((tool) => tool.name === TOOL_NAMES.recommendStart).inputSchema.required,
    ["candidate_limit", "filter", "criteria"]
  );
  const searchTool = response.result.tools.find((tool) => tool.name === TOOL_NAMES.searchStart);
  assert.equal(searchTool.inputSchema.properties.profile.type, "string");
  assert.equal(searchTool.inputSchema.properties.job.type, "string");
  assert.equal(searchTool.inputSchema.properties.hide_read.type, "boolean");
  assert.deepEqual(searchTool.inputSchema.required, ["profile", "job", "hide_read", "criteria", "candidate_limit"]);
  const chatTool = response.result.tools.find((tool) => tool.name === TOOL_NAMES.chatStart);
  assert.equal(chatTool.inputSchema.properties.unread_only.type, "boolean");
  assert.deepEqual(chatTool.inputSchema.required, ["candidate_limit", "job", "unread_only", "criteria"]);
  assert.equal(Object.hasOwn(chatTool.inputSchema.properties, "filter"), false);
  assert.equal(chatTool.description.includes("liepin_recommend_filter_options"), false);
  assert.equal(chatTool.description.includes("unread_only"), true);
});

test("run status returns compact run payload by default", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-json-rpc-"));
  const previous = process.env[ENV_HOME];
  process.env[ENV_HOME] = path.join(workspaceRoot, ".liepin-home");
  try {
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.RECOMMEND,
      input: { workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING }
    });
    updateRunProgress(workspaceRoot, snapshot.run_id, {
      stage: "recommend_llm",
      statusMessage: "正在评估推荐候选人：王五",
      progress: {
        workflow: RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
        currentScan: 1,
        scannedCandidates: 0
      }
    });
    markRunCompleted(workspaceRoot, snapshot.run_id, {
      workflow: RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
      summary: { ok: true },
      result: { items: [{ index: 0 }] }
    });

    const response = await handleJsonRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: TOOL_NAMES.runStatus,
        arguments: { run_id: snapshot.run_id }
      }
    }, workspaceRoot);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.status, "RUN_STATUS");
    assert.equal(payload.run.summary.ok, true);
    assert.equal(payload.run.progress.currentScan, 1);
    assert.equal(Object.hasOwn(payload.run, "result"), false);
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previous;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("run progress lists unified latest runs and filters by kind", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-json-rpc-"));
  const previous = process.env[ENV_HOME];
  process.env[ENV_HOME] = path.join(workspaceRoot, ".liepin-home");
  try {
    const chatRun = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.CHAT,
      input: {
        workflow: RUN_WORKFLOWS.CHAT_SCREENING,
        candidate_limit: 2
      }
    });
    updateRunProgress(workspaceRoot, chatRun.run_id, {
      stage: "chat_llm",
      statusMessage: "正在评估聊天候选人：李四",
      progress: {
        workflow: RUN_WORKFLOWS.CHAT_SCREENING,
        targetCandidates: 2,
        processedCandidates: 1,
        requestResumeSuccesses: 0
      }
    });
    const searchRun = createRunSnapshot({
      workspaceRoot,
      kind: RUN_KINDS.SEARCH,
      input: {
        workflow: RUN_WORKFLOWS.SEARCH_CHAT_CHAIN
      }
    });
    markRunCompleted(workspaceRoot, searchRun.run_id, {
      workflow: RUN_WORKFLOWS.SEARCH_CHAT_CHAIN,
      summary: { ok: true },
      result: { items: [] }
    });

    const response = await handleJsonRpc({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: TOOL_NAMES.runProgress,
        arguments: {
          kind: RUN_KINDS.CHAT,
          include_completed: false
        }
      }
    }, workspaceRoot);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(response.result.isError, false);
    assert.equal(payload.status, "RUN_PROGRESS");
    assert.equal(payload.active_count, 1);
    assert.equal(payload.runs.length, 1);
    assert.equal(payload.latest_run.kind, RUN_KINDS.CHAT);
    assert.equal(payload.latest_run.progress.processedCandidates, 1);
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previous;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("recommend-chat start defaults to production click actions over JSON-RPC", async () => {
  const response = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: TOOL_NAMES.recommendChatStart,
      arguments: {
        mock_llm: true,
        candidate_limit: 1
      }
    }
  }, process.cwd(), { spawnWorker: stubWorker, runDoctorFn: okDoctor });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, false);
  assert.equal(payload.status, "ACCEPTED");
  assert.equal(payload.workflow, RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN);
});

test("recommend start defaults to production chain over JSON-RPC", async () => {
  const response = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: TOOL_NAMES.recommendStart,
      arguments: {
        mock_llm: true,
        candidate_limit: 1
      }
    }
  }, process.cwd(), { spawnWorker: stubWorker, runDoctorFn: okDoctor });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, false);
  assert.equal(payload.status, "ACCEPTED");
  assert.equal(payload.workflow, RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN);
});

test("chat start requires chat-only screening inputs over JSON-RPC", async () => {
  const response = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: TOOL_NAMES.chatStart,
      arguments: {
        mock_llm: true
      }
    }
  }, process.cwd(), { spawnWorker: stubWorker, runDoctorFn: okDoctor });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, true);
  assert.equal(payload.error.message.includes("candidate_limit"), true);
});

test("chat start defaults to chat screening over JSON-RPC", async () => {
  const observed = [];
  const response = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: TOOL_NAMES.chatStart,
      arguments: {
        mock_llm: true,
        candidate_limit: 1,
        job: "全部职位",
        unread_only: false,
        criteria: "筛选条件"
      }
    }
  }, process.cwd(), {
    spawnWorker: stubWorker,
    runDoctorFn: async (options = {}) => {
      observed.push(options);
      return okDoctor(options);
    }
  });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, false);
  assert.equal(payload.status, "ACCEPTED");
  assert.equal(payload.workflow, RUN_WORKFLOWS.CHAT_SCREENING);
  assert.equal(payload.preflight.targetPage, "chat");
  assert.equal(observed[0].requireChatPage, true);
  assert.equal(observed[0].requireScreeningConfig, false);
});

test("chat start accepts Trae-CN string boolean arguments", async () => {
  const observed = [];
  const response = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 15,
    method: "tools/call",
    params: {
      name: TOOL_NAMES.chatStart,
      arguments: {
        mock_llm: "true",
        candidate_limit: "1",
        job: "全部职位",
        unread_only: "false",
        criteria: "筛选条件",
        allow_request_resume: "true"
      }
    }
  }, process.cwd(), {
    spawnWorker: stubWorker,
    runDoctorFn: async (options = {}) => {
      observed.push(options);
      return okDoctor(options);
    }
  });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, false);
  assert.equal(payload.status, "ACCEPTED");
  assert.equal(payload.workflow, RUN_WORKFLOWS.CHAT_SCREENING);
  assert.equal(observed[0].targetPage, "chat");
  assert.equal(observed[0].requireScreeningConfig, false);
});

test("recommend start rejects chat-only arguments instead of running recommend", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-json-rpc-"));
  const previous = process.env[ENV_HOME];
  process.env[ENV_HOME] = path.join(workspaceRoot, ".liepin-home");
  try {
    const response = await handleJsonRpc({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: TOOL_NAMES.recommendStart,
        arguments: {
          mock_llm: "true",
          candidate_limit: "1",
          job: "全部职位",
          unread_only: "false",
          criteria: "筛选条件",
          allow_request_resume: "true"
        }
      }
    }, workspaceRoot, {
      spawnWorker: stubWorker,
      runDoctorFn: okDoctor
    });
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(response.result.isError, true);
    assert.equal(payload.status, "FAILED");
    assert.equal(payload.error.code, "CHAT_ONLY_TOOL_MISROUTE");
    assert.equal(payload.error.message.includes("liepin_chat_start"), true);
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previous;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("search start defaults to search chat chain over JSON-RPC", async () => {
  const response = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: TOOL_NAMES.searchStart,
      arguments: {
        mock_llm: true,
        profile: "测试",
        job: "招聘实习生",
        hide_read: false,
        candidate_limit: 1
      }
    }
  }, process.cwd(), { spawnWorker: stubWorker, runDoctorFn: okDoctor });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, false);
  assert.equal(payload.status, "ACCEPTED");
  assert.equal(payload.workflow, RUN_WORKFLOWS.SEARCH_CHAT_CHAIN);
});

test("search start validates and canonicalizes page option names before accepting", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-json-rpc-"));
  const previous = process.env[ENV_HOME];
  process.env[ENV_HOME] = path.join(workspaceRoot, ".liepin-home");
  try {
    const response = await handleJsonRpc({
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: {
        name: TOOL_NAMES.searchStart,
        arguments: {
          profile: "杭州 算法",
          job: "科研算法工程师(大模型与 aigc 方向)",
          hide_read: true,
          criteria: "筛选条件",
          candidate_limit: 1
        }
      }
    }, workspaceRoot, {
      spawnWorker: stubWorker,
      runDoctorFn: okDoctor,
      discoverSearchOptionsFn: async () => ({
        passed: true,
        profiles: [{ title: "杭州算法" }],
        jobs: [{ title: "科研算法工程师（大模型与AIGC方向）\u200b " }],
        checkedJobConditions: []
      })
    });
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(response.result.isError, false);
    assert.equal(payload.status, "ACCEPTED");
    assert.equal(payload.preflight.searchOptions.profile.canonical, "杭州算法");
    assert.equal(payload.preflight.searchOptions.job.canonical, "科研算法工程师（大模型与AIGC方向）");

    const snapshot = readRunState(workspaceRoot, payload.run_id);
    assert.equal(snapshot.input.profile, "杭州算法");
    assert.equal(snapshot.input.job, "科研算法工程师（大模型与AIGC方向）");
    assert.equal(snapshot.input.hide_read, true);
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previous;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("search start rejects unmatched page option names before queueing", async () => {
  const response = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 18,
    method: "tools/call",
    params: {
      name: TOOL_NAMES.searchStart,
      arguments: {
        profile: "杭州算法",
        job: "不存在的职位",
        hide_read: true,
        criteria: "筛选条件",
        candidate_limit: 1
      }
    }
  }, process.cwd(), {
    spawnWorker: stubWorker,
    runDoctorFn: okDoctor,
    discoverSearchOptionsFn: async () => ({
      passed: true,
      profiles: [{ title: "杭州算法" }],
      jobs: [{ title: "科研算法工程师（大模型与AIGC方向）" }],
      checkedJobConditions: []
    })
  });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, true);
  assert.equal(payload.status, "FAILED");
  assert.equal(payload.error.code, "SEARCH_START_OPTION_MISMATCH");
  assert.equal(payload.error.message.includes("不存在的职位"), true);
});

test("search start rejects when chat action is not allowed", async () => {
  const response = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: TOOL_NAMES.searchStart,
      arguments: {
        mock_llm: true,
        profile: "测试",
        job: "招聘实习生",
        hide_read: false,
        candidate_limit: 1,
        allow_chat_action: false
      }
    }
  }, process.cwd(), { spawnWorker: stubWorker, runDoctorFn: okDoctor });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, true);
  assert.equal(payload.error.code, "SIDE_EFFECT_APPROVAL_REQUIRED");
});

test("start tools run target-page doctor preflight before accepting", async () => {
  const observed = [];
  const response = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: TOOL_NAMES.searchStart,
      arguments: {
        mock_llm: true,
        profile: "测试",
        job: "招聘实习生",
        hide_read: false,
        candidate_limit: 1
      }
    }
  }, process.cwd(), {
    spawnWorker: stubWorker,
    runDoctorFn: async (options = {}) => {
      observed.push(options);
      return okDoctor(options);
    }
  });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, false);
  assert.equal(payload.preflight.targetPage, "search");
  assert.equal(observed[0].targetPage, "search");
  assert.equal(observed[0].fix, true);
  assert.equal(observed[0].requireScreeningConfig, false);
});

test("doctor auto-fixes when a target page is requested over JSON-RPC", async () => {
  const observed = [];
  const response = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: TOOL_NAMES.doctor,
      arguments: {
        target_page: "chat",
        require_chat_page: true
      }
    }
  }, process.cwd(), {
    runDoctorFn: async (options = {}) => {
      observed.push(options);
      return okDoctor(options);
    }
  });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, false);
  assert.equal(payload.targetPage, "chat");
  assert.equal(observed[0].fix, true);
});

test("doctor uses configured debugPort when debug_port is omitted", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-json-rpc-"));
  const previous = process.env[ENV_HOME];
  process.env[ENV_HOME] = path.join(workspaceRoot, ".liepin-home");
  try {
    fs.mkdirSync(path.join(workspaceRoot, "config"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, "config", "screening-config.json"), JSON.stringify({
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
      model: "test-model",
      debugPort: 9223
    }), "utf8");
    const response = await handleJsonRpc({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: TOOL_NAMES.doctor,
        arguments: {}
      }
    }, workspaceRoot);
    const payload = JSON.parse(response.result.content[0].text);
    const chromeCheck = payload.checks.find((item) => item.key === "chrome_9222");
    assert.equal(Boolean(chromeCheck), true);
    assert.equal(chromeCheck.message.includes("9223"), true);
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previous;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("install and export tools are callable over JSON-RPC", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-json-rpc-"));
  await withIsolatedRuntimeAndProfiles(workspaceRoot, async () => {
    const installResponse = await handleJsonRpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: TOOL_NAMES.install,
        arguments: {
          write_config_template: true
        }
      }
    }, workspaceRoot);
    const installPayload = JSON.parse(installResponse.result.content[0].text);
    assert.equal(installPayload.ok, true);

    const exportResponse = await handleJsonRpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: TOOL_NAMES.externalAgentConfig,
        arguments: {}
      }
    }, workspaceRoot);
    const exportPayload = JSON.parse(exportResponse.result.content[0].text);
    assert.equal(exportPayload.ok, true);
    assert.equal(fs.existsSync(exportPayload.path), true);
  });
});

async function withIsolatedRuntimeAndProfiles(workspaceRoot, callback) {
  const previous = {
    [ENV_HOME]: process.env[ENV_HOME],
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    APPDATA: process.env.APPDATA
  };
  const fakeHome = path.join(workspaceRoot, "profile");
  const fakeAppData = path.join(fakeHome, "AppData", "Roaming");
  const parsedHome = path.parse(path.resolve(fakeHome));

  process.env[ENV_HOME] = path.join(workspaceRoot, ".liepin-home");
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.HOMEDRIVE = parsedHome.root.replace(/\\$/, "");
  process.env.HOMEPATH = `\\${path.relative(parsedHome.root, fakeHome).replace(/\//g, "\\")}`;
  process.env.APPDATA = fakeAppData;

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}
