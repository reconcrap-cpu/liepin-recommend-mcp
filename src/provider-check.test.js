import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ENV_HOME } from "./constants.js";
import { runProviderCheck, summarizeProviderCheck } from "./provider-check.js";

test("runProviderCheck validates both screening modes without exposing api keys", async () => {
  const result = await runProviderCheck({
    config: {
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-secret",
      model: "test-model"
    },
    provider: async ({ request }) => ({
      content: JSON.stringify({
        decision: "pass",
        post_action: request.response_contract.post_action[0]
      })
    })
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.checkedModes, ["recommend", "chat"]);
  assert.deepEqual(summarizeProviderCheck(result).passedModes, ["recommend", "chat"]);
  assert.equal(JSON.stringify(result).includes("sk-secret"), false);
});

test("runProviderCheck skips network work when screening config is missing", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-provider-check-"));
  const previous = process.env[ENV_HOME];
  process.env[ENV_HOME] = path.join(workspaceRoot, ".liepin-home");
  let providerCalled = false;
  try {
    const result = await runProviderCheck({
      workspaceRoot,
      provider: async () => {
        providerCalled = true;
        return { content: "{}" };
      }
    });

    assert.equal(providerCalled, false);
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.configReady, false);
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previous;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
