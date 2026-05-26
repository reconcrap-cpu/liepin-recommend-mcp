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
    assert.equal(result.reasoningText, "native reasoning chunk");
    assert.equal(fs.readFileSync(reasoningLogPath, "utf8"), "native reasoning chunk\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runStructuredScreening captures native reasoning fields without requesting reasons", async () => {
  const result = await runStructuredScreening({
    mode: "recommend",
    screenInput,
    config: {
      model: "test-model"
    },
    provider: async ({ request }) => {
      assert.equal(JSON.stringify(request).includes("\"reason\""), false);
      return {
        choices: [
          {
            message: {
              reasoning_content: "先核对经历，再给出结构化结论。",
              content: JSON.stringify({
                decision: "fail",
                post_action: "none"
              })
            }
          }
        ]
      };
    }
  });

  assert.equal(result.reasoningCaptured, true);
  assert.equal(result.reasoningText, "先核对经历，再给出结构化结论。");
  assert.deepEqual(result.decision, {
    decision: "fail",
    post_action: "none"
  });
});

test("runStructuredScreening requests reasoning controls and parses streamed CoT", async () => {
  const payloads = [];
  const streamBody = [
    "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"checked mandatory criteria. \"}}]}",
    "",
    "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"decision\\\":\\\"pass\\\",\\\"post_action\\\":\\\"chat\\\"}\"}}]}",
    "",
    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}",
    "",
    "data: [DONE]",
    ""
  ].join("\n");
  const result = await runStructuredScreening({
    mode: "recommend",
    screenInput,
    config: {
      baseUrl: "https://coding.qunhequnhe.com/v1",
      apiKey: "sk-test",
      model: "doubao-seed-2.0-code",
      reasoningEffort: "low",
      reasoningStream: true
    },
    fetchImpl: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return new Response(streamBody, {
        status: 200,
        headers: {
          "content-type": "text/event-stream"
        }
      });
    }
  });

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].reasoning_effort, "low");
  assert.equal(payloads[0].stream, true);
  assert.deepEqual(payloads[0].thinking, { type: "enabled" });
  assert.equal(result.request.provider_request.body.reasoning_effort, "low");
  assert.equal(result.request.provider_request.body.stream, true);
  assert.deepEqual(result.request.provider_request.body.thinking, { type: "enabled" });
  assert.equal(result.reasoningCaptured, true);
  assert.equal(result.reasoningText, "checked mandatory criteria.");
  assert.deepEqual(result.decision, {
    decision: "pass",
    post_action: "chat"
  });
});

test("runStructuredScreening captures DeepSeek streamed reasoning through generic thinking fallback", async () => {
  const payloads = [];
  let calls = 0;
  const streamBody = [
    "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"先检查硬性条件。\"}}]}",
    "",
    "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"decision\\\":\\\"fail\\\",\\\"post_action\\\":\\\"none\\\"}\"}}]}",
    "",
    "data: [DONE]",
    ""
  ].join("\n");
  const result = await runStructuredScreening({
    mode: "recommend",
    screenInput,
    config: {
      baseUrl: "https://coding.qunhequnhe.com/v1",
      apiKey: "sk-test",
      model: "deepseek-v4-flash",
      reasoningEffort: "low",
      reasoningStream: true
    },
    fetchImpl: async (_url, options) => {
      calls += 1;
      payloads.push(JSON.parse(options.body));
      if (calls === 1) {
        return new Response("unknown field: thinking", {
          status: 400,
          statusText: "Bad Request"
        });
      }
      return new Response(streamBody, {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }
  });

  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].reasoning_effort, "low");
  assert.equal(payloads[0].stream, true);
  assert.deepEqual(payloads[0].thinking, { type: "enabled" });
  assert.equal(payloads[1].reasoning_effort, "low");
  assert.equal(payloads[1].stream, true);
  assert.equal(Object.prototype.hasOwnProperty.call(payloads[1], "thinking"), false);
  assert.equal(result.request.provider_request.body.reasoning_effort, "low");
  assert.equal(result.request.provider_request.body.stream, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.request.provider_request.body, "thinking"), false);
  assert.deepEqual(result.request.provider_request.compatibility_downgrades, {
    thinking: true
  });
  assert.equal(result.reasoningCaptured, true);
  assert.equal(result.reasoningText, "先检查硬性条件。");
  assert.deepEqual(result.decision, {
    decision: "fail",
    post_action: "none"
  });
});

test("runStructuredScreening downgrades unsupported thinking flag but keeps compatible reasoning fields", async () => {
  let calls = 0;
  const payloads = [];
  const result = await runStructuredScreening({
    mode: "recommend",
    screenInput,
    config: {
      baseUrl: "https://fallback.example/v1",
      apiKey: "sk-test",
      model: "fallback-reasoning-model",
      reasoningEffort: "medium",
      reasoningStream: true
    },
    fetchImpl: async (_url, options) => {
      calls += 1;
      payloads.push(JSON.parse(options.body));
      if (calls === 1) {
        return new Response("unknown field: thinking", {
          status: 400,
          statusText: "Bad Request"
        });
      }
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              reasoning_content: "provider accepted reasoning_effort after removing thinking.",
              content: JSON.stringify({
                decision: "fail",
                post_action: "none"
              })
            }
          }
        ]
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }
  });

  assert.equal(calls, 2);
  assert.equal(payloads[0].reasoning_effort, "medium");
  assert.deepEqual(payloads[0].thinking, { type: "enabled" });
  assert.equal(payloads[1].reasoning_effort, "medium");
  assert.equal(Object.prototype.hasOwnProperty.call(payloads[1], "thinking"), false);
  assert.equal(payloads[1].stream, true);
  assert.equal(result.reasoningCaptured, true);
  assert.equal(result.reasoningText, "provider accepted reasoning_effort after removing thinking.");
  assert.deepEqual(result.decision, {
    decision: "fail",
    post_action: "none"
  });
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
