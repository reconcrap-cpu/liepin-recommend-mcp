import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { buildScreeningLlmRequest, runStructuredScreening } from "./llm-adapter.js";

const screenInput = {
  schemaVersion: "liepin_screen_input_v1",
  candidate: {
    label: "candidate"
  },
  manifest: {
    payloadHash: "hash",
    sectionHashes: []
  },
  payloadText: "[section:0:job_intent:求职意向]\nHR"
};

test("buildScreeningLlmRequest requests only structured decision fields", () => {
  const request = buildScreeningLlmRequest({
    mode: "recommend",
    screenInput,
    config: {
      model: "test-model"
    }
  });

  assert.equal(request.model, "test-model");
  assert.deepEqual(request.response_contract, {
    decision: ["pass", "fail"],
    post_action: ["chat", "none"]
  });
  assert.equal(request.response_format, undefined);
  assert.equal(JSON.stringify(request).includes("\"reason\""), false);
});

test("buildScreeningLlmRequest carries operator criteria and filters when provided", () => {
  const request = buildScreeningLlmRequest({
    mode: "chat",
    screenInput,
    config: {
      model: "test-model"
    },
    criteria: "优先 5 年以上 Java 后端经验",
    operatorFilters: "有简历"
  });
  const userPayload = JSON.parse(request.messages[1].content);
  assert.equal(userPayload.operator_criteria, "优先 5 年以上 Java 后端经验");
  assert.equal(userPayload.operator_filters, "有简历");
});

test("runStructuredScreening writes provider-native reasoning chunks when available", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-llm-"));
  const reasoningLogPath = path.join(tempDir, "reasoning.log");
  try {
    const result = await runStructuredScreening({
      mode: "chat",
      screenInput,
      config: {
        model: "test-model"
      },
      reasoningLogPath,
      provider: async ({ onReasoningDelta }) => {
        onReasoningDelta("native reasoning chunk\n");
        return {
          content: JSON.stringify({
            decision: "pass",
            post_action: "request_resume"
          })
        };
      }
    });

    assert.deepEqual(result.decision, {
      decision: "pass",
      post_action: "request_resume"
    });
    assert.equal(result.reasoningCaptured, true);
    assert.equal(fs.readFileSync(reasoningLogPath, "utf8"), "native reasoning chunk\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runStructuredScreening accepts providers without reasoning stream", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-llm-"));
  const reasoningLogPath = path.join(tempDir, "reasoning.log");
  try {
    const result = await runStructuredScreening({
      mode: "recommend",
      screenInput,
      config: {
        model: "test-model"
      },
      reasoningLogPath,
      provider: async () => ({
        content: JSON.stringify({
          decision: "fail",
          post_action: "none"
        })
      })
    });

    assert.deepEqual(result.decision, {
      decision: "fail",
      post_action: "none"
    });
    assert.equal(result.reasoningCaptured, false);
    assert.equal(fs.existsSync(reasoningLogPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runStructuredScreening repairs one invalid schema response", async () => {
  let calls = 0;
  const result = await runStructuredScreening({
    mode: "recommend",
    screenInput,
    config: {
      model: "test-model",
      llmSchemaMaxRetries: 1
    },
    provider: async ({ request }) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: JSON.stringify({
            decision: "The candidate looks qualified.",
            post_action: "chat"
          })
        };
      }
      assert.equal(request.messages.some((message) => message.content.includes("violated the schema")), true);
      return {
        content: JSON.stringify({
          decision: "pass",
          post_action: "chat"
        })
      };
    }
  });

  assert.equal(calls, 2);
  assert.equal(result.schemaRepairAttempts, 1);
  assert.deepEqual(result.decision, {
    decision: "pass",
    post_action: "chat"
  });
});

test("runStructuredScreening normalizes explicit accept/reject aliases", async () => {
  const result = await runStructuredScreening({
    mode: "recommend",
    screenInput,
    config: {
      model: "test-model"
    },
    provider: async () => ({
      content: JSON.stringify({
        decision: "accept",
        post_action: "chat"
      })
    })
  });

  assert.deepEqual(result.decision, {
    decision: "pass",
    post_action: "chat"
  });
});

test("runStructuredScreening accepts fenced JSON output without response_format", async () => {
  const result = await runStructuredScreening({
    mode: "recommend",
    screenInput,
    config: {
      model: "test-model"
    },
    provider: async () => ({
      content: "```json\n{\"decision\":\"pass\",\"post_action\":\"chat\"}\n```"
    })
  });

  assert.deepEqual(result.decision, {
    decision: "pass",
    post_action: "chat"
  });
});

test("runStructuredScreening retries transient OpenAI-compatible HTTP failures", async () => {
  let calls = 0;
  const payloads = [];
  const result = await runStructuredScreening({
    mode: "recommend",
    screenInput,
    config: {
      baseUrl: "https://llm.example/v1",
      apiKey: "sk-test",
      model: "test-model",
      llmMaxRetries: 1
    },
    fetchImpl: async (_url, options) => {
      calls += 1;
      payloads.push(options?.body ? JSON.parse(options.body) : null);
      if (calls === 1) {
        return {
          ok: false,
          status: 500,
          statusText: "Server Error"
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: "fail",
                  post_action: "none"
                })
              }
            }
          ]
        })
      };
    }
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.decision, {
    decision: "fail",
    post_action: "none"
  });
  assert.equal(Object.prototype.hasOwnProperty.call(payloads[0] || {}, "response_format"), false);
});
