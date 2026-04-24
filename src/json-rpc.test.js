import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { handleJsonRpc } from "./json-rpc.js";
import { ENV_HOME, RUN_KINDS, RUN_WORKFLOWS, TOOL_NAMES } from "./constants.js";
import { createRunSnapshot, markRunCompleted, updateRunProgress } from "./run-state.js";

const stubWorker = () => ({ pid: 12345 });

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
  const recommendChatTool = response.result.tools.find((tool) => tool.name === TOOL_NAMES.recommendChatStart);
  assert.equal(recommendChatTool.inputSchema.properties.allow_chat_action.type, "boolean");
  assert.equal(recommendChatTool.inputSchema.properties.allow_request_resume.type, "boolean");
  assert.equal(recommendChatTool.inputSchema.properties.candidate_limit.description.includes("pass"), true);
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
  }, process.cwd(), { spawnWorker: stubWorker });
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
  }, process.cwd(), { spawnWorker: stubWorker });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, false);
  assert.equal(payload.status, "ACCEPTED");
  assert.equal(payload.workflow, RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN);
});

test("chat start defaults to production chain over JSON-RPC", async () => {
  const response = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: TOOL_NAMES.chatStart,
      arguments: {
        mock_llm: true,
        candidate_limit: 1
      }
    }
  }, process.cwd(), { spawnWorker: stubWorker });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, false);
  assert.equal(payload.status, "ACCEPTED");
  assert.equal(payload.workflow, RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN);
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
