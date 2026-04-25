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
    assert.equal(Boolean(config.mcpServers["liepin-mcp"]), true);
    assert.equal(config.mcpServers["liepin-mcp"].command, "node");
    assert.equal(
      config.mcpServers["liepin-mcp"].args.some((item) => String(item).endsWith(path.join("bin", "liepin-recommend-mcp.js"))),
      true
    );
    assert.equal(config.mcpServers["liepin-mcp"].args.includes("start"), true);
    assert.equal(
      config.mcpServers["liepin-mcp"].env.LIEPIN_WORKSPACE_ROOT,
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

test("runInstall syncs MCP config and skill into trae-cn targets", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-platform-"));
  withRuntimeHome(workspaceRoot, () => {
    const fakeHome = path.join(workspaceRoot, "profile");
    const fakeAppData = path.join(fakeHome, "AppData", "Roaming");
    const traeMcpPath = path.join(fakeAppData, "Trae", "User", "mcp.json");
    const traeSkillsDir = path.join(fakeAppData, "Trae", "User", "skills");

    fs.mkdirSync(path.dirname(traeMcpPath), { recursive: true });
    fs.mkdirSync(traeSkillsDir, { recursive: true });
    fs.writeFileSync(traeMcpPath, JSON.stringify({
      mcpServers: {
        existing: { command: "node", args: ["existing.js"] },
        "liepin-recommend-mcp": {
          command: "npx",
          args: ["-y", "@reconcrap/liepin-recommend-mcp@0.1.8", "start"]
        }
      }
    }, null, 2));

    withFakeHomeAndAppData(fakeHome, fakeAppData, () => {
      const result = runInstall({
        workspaceRoot,
        exportExternalConfig: false,
        agent: "trae-cn"
      });
      assert.equal(result.ok, true);
      assert.equal(
        result.externalMcpConfigs.applied.some((item) => path.resolve(item.file) === path.resolve(traeMcpPath)),
        true
      );
      const mcpConfig = JSON.parse(fs.readFileSync(traeMcpPath, "utf8"));
      assert.equal(Boolean(mcpConfig.mcpServers.existing), true);
      assert.equal(Boolean(mcpConfig.mcpServers["liepin-recommend-mcp"]), false);
      assert.equal(Boolean(mcpConfig.mcpServers["liepin-mcp"]), true);
      assert.deepEqual(
        result.externalMcpConfigs.applied.find((item) => path.resolve(item.file) === path.resolve(traeMcpPath)).removedLegacyServers,
        ["liepin-recommend-mcp"]
      );
      assert.equal(
        mcpConfig.mcpServers["liepin-mcp"].env.LIEPIN_WORKSPACE_ROOT,
        path.resolve(workspaceRoot)
      );
      assert.equal(
        fs.existsSync(path.join(traeSkillsDir, "liepin-recommend-pipeline", "SKILL.md")),
        true
      );
      assert.equal(
        fs.existsSync(path.join(traeSkillsDir, "liepin-chat", "SKILL.md")),
        true
      );
      assert.equal(
        fs.existsSync(path.join(traeSkillsDir, "liepin-search", "SKILL.md")),
        true
      );
    });
  });
});

function withRuntimeHome(workspaceRoot, callback) {
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
    return callback();
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

function withFakeHomeAndAppData(fakeHome, fakeAppData, callback) {
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    APPDATA: process.env.APPDATA
  };

  const resolvedHome = path.resolve(fakeHome);
  const parsedHome = path.parse(resolvedHome);
  process.env.HOME = resolvedHome;
  process.env.USERPROFILE = resolvedHome;
  process.env.HOMEDRIVE = parsedHome.root.replace(/\\$/, "");
  process.env.HOMEPATH = `\\${path.relative(parsedHome.root, resolvedHome).replace(/\//g, "\\")}`;
  process.env.APPDATA = fakeAppData;

  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
