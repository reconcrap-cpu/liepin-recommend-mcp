import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ENV_HOME } from "./constants.js";
import { readScreeningConfig, validateScreeningConfig, writeScreeningConfigTemplate } from "./config.js";

test("validateScreeningConfig rejects placeholder config", () => {
  const result = validateScreeningConfig({
    baseUrl: "https://example.com/v1",
    apiKey: "replace-with-real-api-key",
    model: "test-model"
  });
  assert.equal(result.ok, false);
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
  const configDir = path.join(workspaceRoot, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "screening-config.json"), JSON.stringify({
    baseUrl: "https://example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    llmThinkingLevel: "low"
  }), "utf8");
  try {
    const resolution = readScreeningConfig(workspaceRoot);
    assert.equal(resolution.ok, true);
    assert.equal(resolution.config.reasoningEffort, "low");
    assert.equal(resolution.config.llmSchemaMaxRetries, 1);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
