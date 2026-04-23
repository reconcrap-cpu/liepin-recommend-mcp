import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handleJsonRpc } from "./json-rpc.js";
import { ENV_HOME, RUN_KINDS, RUN_WORKFLOWS, TOOL_NAMES } from "./constants.js";
import { createRunSnapshot, markRunCompleted, updateRunProgress } from "./run-state.js";

test("tools/list exposes liepin-prefixed tools", async () => {
  const response = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list"
  }, process.cwd());
  assert.equal(response.result.tools.some((tool) => tool.name === "liepin_doctor"), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.install), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.selfHeal), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.skillExport), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.externalAgentConfig), true);
  assert.equal(response.result.tools.some((tool) => tool.name === TOOL_NAMES.providerCheck), true);
  const recommendChatTool = response.result.tools.find((tool) => tool.name === TOOL_NAMES.recommendChatStart);
  assert.equal(recommendChatTool.inputSchema.properties.allow_chat_action.type, "boolean");
  assert.equal(recommendChatTool.inputSchema.properties.allow_request_resume.type, "boolean");
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

test("recommend-chat start requires explicit chat approval over JSON-RPC", async () => {
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
  }, process.cwd());
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, true);
  assert.equal(payload.error.code, "SIDE_EFFECT_APPROVAL_REQUIRED");
});

test("install and export tools are callable over JSON-RPC", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-json-rpc-"));
  const previous = process.env[ENV_HOME];
  process.env[ENV_HOME] = path.join(workspaceRoot, ".liepin-home");
  try {
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
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previous;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
