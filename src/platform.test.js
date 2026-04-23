import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ENV_HOME } from "./constants.js";
import {
  buildExternalAgentConfig,
  exportSkill,
  runInstall
} from "./platform.js";

test("runInstall writes runtime assets and external agent config", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-platform-"));
  withRuntimeHome(workspaceRoot, () => {
    const result = runInstall({
      workspaceRoot
    });
    assert.equal(result.ok, true);
    assert.equal(result.runtimeLayout.workspaceRoot, path.resolve(workspaceRoot));
    assert.equal(result.externalAgentConfig.ok, true);
    assert.equal(fs.existsSync(result.externalAgentConfig.path), true);
    assert.equal(fs.existsSync(result.screeningConfig.path), true);
  });
});

test("buildExternalAgentConfig includes MCP server bootstrap fields", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-platform-"));
  withRuntimeHome(workspaceRoot, () => {
    const config = buildExternalAgentConfig({ workspaceRoot });
    assert.equal(Boolean(config.mcpServers["liepin-recommend-mcp"]), true);
    assert.equal(
      config.mcpServers["liepin-recommend-mcp"].env.LIEPIN_WORKSPACE_ROOT,
      path.resolve(workspaceRoot)
    );
  });
});

test("exportSkill supports markdown and json formats", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-platform-"));
  withRuntimeHome(workspaceRoot, () => {
    const markdown = exportSkill({
      workspaceRoot,
      format: "markdown"
    });
    const json = exportSkill({
      workspaceRoot,
      format: "json"
    });
    assert.equal(markdown.ok, true);
    assert.equal(json.ok, true);
    assert.equal(fs.existsSync(markdown.path), true);
    assert.equal(fs.existsSync(json.path), true);
    const payload = JSON.parse(fs.readFileSync(json.path, "utf8"));
    assert.equal(payload.schemaVersion, "liepin_skill_export_v1");
  });
});

function withRuntimeHome(workspaceRoot, callback) {
  const previous = process.env[ENV_HOME];
  process.env[ENV_HOME] = path.join(workspaceRoot, ".liepin-home");
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previous;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}
