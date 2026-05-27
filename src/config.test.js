import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ENV_CONFIG, ENV_HOME } from "./constants.js";
import {
  readScreeningConfig,
  resolveScreeningConfigPath,
  resolveDefaultDebugPort,
  validateScreeningConfig,
  writeScreeningConfigTemplate
} from "./config.js";

test("validateScreeningConfig rejects placeholder config", () => {
  const result = validateScreeningConfig({
    baseUrl: "https://your-llm-endpoint.example.com/v1",
    apiKey: "replace-with-real-api-key",
    model: "your-model-name"
  });
  assert.equal(result.ok, false);
});

test("validateScreeningConfig rejects template baseUrl and model even with non-placeholder apiKey", () => {
  const result = validateScreeningConfig({
    baseUrl: "https://your-llm-endpoint.example.com/v1",
    apiKey: "sk-test",
    model: "your-model-name"
  });
  assert.equal(result.ok, false);
  assert.equal(result.message.includes("baseUrl"), true);
  assert.equal(result.message.includes("model"), true);
});

test("validateScreeningConfig accepts usable config", () => {
  const result = validateScreeningConfig({
    baseUrl: "https://example.com/v1",
    apiKey: "sk-test",
    model: "test-model"
  });
  assert.equal(result.ok, true);
});

test("writeScreeningConfigTemplate creates a non-overwriting config template", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-config-"));
  const previous = process.env[ENV_HOME];
  process.env[ENV_HOME] = path.join(workspaceRoot, ".liepin-home");
  try {
    const first = writeScreeningConfigTemplate(workspaceRoot);
    const second = writeScreeningConfigTemplate(workspaceRoot);
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(fs.existsSync(first.path), true);
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previous;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("readScreeningConfig accepts boss-style llmThinkingLevel", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-config-"));
  const stateHome = path.join(workspaceRoot, ".liepin-home");
  const workspaceConfigDir = path.join(workspaceRoot, "config");
  fs.mkdirSync(stateHome, { recursive: true });
  fs.mkdirSync(workspaceConfigDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceConfigDir, "screening-config.json"), JSON.stringify({
    baseUrl: "https://wrong-workspace.example/v1",
    apiKey: "sk-workspace",
    model: "workspace-should-not-win",
    llmThinkingLevel: "high"
  }), "utf8");
  fs.writeFileSync(path.join(stateHome, "screening-config.json"), JSON.stringify({
    baseUrl: "https://example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    llmThinkingLevel: "low"
  }), "utf8");
  const previous = process.env[ENV_HOME];
  process.env[ENV_HOME] = stateHome;
  try {
    const resolution = readScreeningConfig(workspaceRoot);
    assert.equal(resolution.ok, true);
    assert.equal(resolveScreeningConfigPath(workspaceRoot), path.join(stateHome, "screening-config.json"));
    assert.equal(resolution.config.model, "test-model");
    assert.equal(resolution.config.reasoningEffort, "low");
    assert.equal(resolution.config.llmRetryDelayMs, 1000);
    assert.equal(resolution.config.llmRateLimitRetryDelayMs, 30000);
    assert.equal(resolution.config.llmRetryMaxDelayMs, 120000);
    assert.equal(resolution.config.llmSchemaMaxRetries, 1);
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previous;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("readScreeningConfig ignores external config overrides outside install state", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-config-"));
  const stateHome = path.join(workspaceRoot, ".liepin-home");
  const overrideDir = path.join(workspaceRoot, "openclaw");
  fs.mkdirSync(stateHome, { recursive: true });
  fs.mkdirSync(overrideDir, { recursive: true });
  fs.writeFileSync(path.join(stateHome, "screening-config.json"), JSON.stringify({
    baseUrl: "https://example.com/v1",
    apiKey: "sk-test",
    model: "state-home-model"
  }), "utf8");
  fs.writeFileSync(path.join(overrideDir, "screening-config.json"), JSON.stringify({
    baseUrl: "https://wrong.example/v1",
    apiKey: "sk-wrong",
    model: "openclaw-should-not-win"
  }), "utf8");
  const previousHome = process.env[ENV_HOME];
  const previousConfig = process.env[ENV_CONFIG];
  process.env[ENV_HOME] = stateHome;
  process.env[ENV_CONFIG] = path.join(overrideDir, "screening-config.json");
  try {
    const resolution = readScreeningConfig(workspaceRoot);
    assert.equal(resolution.ok, true);
    assert.equal(resolution.configPath, path.join(stateHome, "screening-config.json"));
    assert.equal(resolution.config.model, "state-home-model");
  } finally {
    if (previousHome === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previousHome;
    }
    if (previousConfig === undefined) {
      delete process.env[ENV_CONFIG];
    } else {
      process.env[ENV_CONFIG] = previousConfig;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("readScreeningConfig parses reasoning compatibility controls", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-config-"));
  const stateHome = path.join(workspaceRoot, ".liepin-home");
  fs.mkdirSync(stateHome, { recursive: true });
  fs.writeFileSync(path.join(stateHome, "screening-config.json"), JSON.stringify({
    baseUrl: "https://example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    reasoningEnabled: "true",
    reasoningStream: "false",
    llmExtraBody: {
      enable_thinking: true
    }
  }), "utf8");
  const previous = process.env[ENV_HOME];
  process.env[ENV_HOME] = stateHome;
  try {
    const resolution = readScreeningConfig(workspaceRoot);
    assert.equal(resolution.ok, true);
    assert.equal(resolution.config.reasoningEnabled, true);
    assert.equal(resolution.config.reasoningStream, false);
    assert.deepEqual(resolution.config.llmExtraBody, {
      enable_thinking: true
    });
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previous;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("resolveDefaultDebugPort prefers screening-config debugPort", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-config-"));
  const stateHome = path.join(workspaceRoot, ".liepin-home");
  fs.mkdirSync(stateHome, { recursive: true });
  fs.writeFileSync(path.join(stateHome, "screening-config.json"), JSON.stringify({
    baseUrl: "https://example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    debugPort: 9223
  }), "utf8");
  const previous = process.env.LIEPIN_DEBUG_PORT;
  const previousHome = process.env[ENV_HOME];
  process.env[ENV_HOME] = stateHome;
  delete process.env.LIEPIN_DEBUG_PORT;
  try {
    assert.equal(resolveDefaultDebugPort(workspaceRoot), 9223);
  } finally {
    if (previous === undefined) {
      delete process.env.LIEPIN_DEBUG_PORT;
    } else {
      process.env.LIEPIN_DEBUG_PORT = previous;
    }
    if (previousHome === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previousHome;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("resolveDefaultDebugPort lets env override screening-config debugPort", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-config-"));
  const stateHome = path.join(workspaceRoot, ".liepin-home");
  fs.mkdirSync(stateHome, { recursive: true });
  fs.writeFileSync(path.join(stateHome, "screening-config.json"), JSON.stringify({
    baseUrl: "https://example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    debugPort: 9223
  }), "utf8");
  const previous = process.env.LIEPIN_DEBUG_PORT;
  const previousHome = process.env[ENV_HOME];
  process.env[ENV_HOME] = stateHome;
  process.env.LIEPIN_DEBUG_PORT = "9333";
  try {
    assert.equal(resolveDefaultDebugPort(workspaceRoot), 9333);
  } finally {
    if (previous === undefined) {
      delete process.env.LIEPIN_DEBUG_PORT;
    } else {
      process.env.LIEPIN_DEBUG_PORT = previous;
    }
    if (previousHome === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previousHome;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
