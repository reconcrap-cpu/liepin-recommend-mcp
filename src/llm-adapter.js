import fs from "node:fs";
import path from "node:path";

import { ensureDirSync, normalizeText } from "./utils.js";

export const SCREENING_MODES = {
  RECOMMEND: "recommend",
  CHAT: "chat"
};

const MODE_SCHEMAS = {
  [SCREENING_MODES.RECOMMEND]: {
    postActions: ["chat", "none"]
  },
  [SCREENING_MODES.CHAT]: {
    postActions: ["request_resume", "none"]
  }
};

export function buildScreeningLlmRequest({
  mode,
  screenInput,
  config,
  criteria = null,
  operatorFilters = null
}) {
  const schema = MODE_SCHEMAS[mode];
  if (!schema) throw new Error(`Unsupported screening mode: ${mode}`);
  const normalizedCriteria = normalizeText(criteria) || null;
  const normalizedFilters = normalizeText(operatorFilters) || null;
  return {
    provider: "openai_compatible",
    endpoint: "/chat/completions",
    model: config?.model || null,
    mode,
    response_contract: {
      decision: ["pass", "fail"],
      post_action: schema.postActions
    },
    messages: [
      {
        role: "system",
        content: [
          "You evaluate recruiting candidates.",
          "Return exactly one JSON object and no surrounding text.",
          "The decision field is an enum, not a sentence.",
          "Use decision=\"pass\" for accept/qualified/yes and decision=\"fail\" for reject/unqualified/no.",
          "Never use accept, reject, yes, no, or explanatory text as the decision value.",
          "When operator_criteria is provided, treat it as mandatory screening guidance.",
          `Allowed post_action values: ${schema.postActions.join(", ")}.`
        ].join(" ")
      },
      {
        role: "user",
        content: JSON.stringify({
          task: mode,
          required_output_schema: {
            decision: ["pass", "fail"],
            post_action: schema.postActions
          },
          valid_output_example: {
            decision: "pass",
            post_action: schema.postActions[0]
          },
          operator_criteria: normalizedCriteria,
          operator_filters: normalizedFilters,
          screen_input_schema: screenInput?.schemaVersion || null,
          manifest: screenInput?.manifest || null,
          candidate: screenInput?.candidate || null,
          cv_payload: screenInput?.payloadText || ""
        })
      }
    ],
    temperature: 0
  };
}

export async function runStructuredScreening({
  mode,
  screenInput,
  config,
  criteria = null,
  operatorFilters = null,
  provider = null,
  reasoningLogPath = null,
  fetchImpl = globalThis.fetch
}) {
  const request = buildScreeningLlmRequest({
    mode,
    screenInput,
    config,
    criteria,
    operatorFilters
  });
  let reasoningCaptured = false;
  const onReasoningDelta = (chunk) => {
    const text = String(chunk || "");
    if (!text) return;
    reasoningCaptured = true;
    if (!reasoningLogPath) return;
    ensureDirSync(path.dirname(reasoningLogPath));
    fs.appendFileSync(reasoningLogPath, text, "utf8");
  };

  let currentRequest = request;
  const maxSchemaRetries = parseNonNegativeInteger(config?.llmSchemaMaxRetries, 1);
  let response = null;
  for (let attempt = 0; attempt <= maxSchemaRetries; attempt += 1) {
    response = provider
      ? await provider({ request: currentRequest, onReasoningDelta })
      : await callOpenAiCompatibleJson({ config, request: currentRequest, fetchImpl });
    const content = extractResponseContent(response);
    try {
      return {
        request: currentRequest,
        decision: normalizeDecision(content, mode),
        reasoningCaptured,
        rawResponse: response,
        schemaRepairAttempts: attempt
      };
    } catch (error) {
      if (attempt >= maxSchemaRetries) throw error;
      currentRequest = buildSchemaRepairRequest({
        request: currentRequest,
        mode,
        invalidContent: content,
        errorMessage: error?.message || "Invalid structured decision"
      });
    }
  }
  throw new Error("LLM schema repair exhausted");
}

async function callOpenAiCompatibleJson({ config, request, fetchImpl }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available for LLM request");
  }
  const baseUrl = normalizeText(config?.baseUrl).replace(/\/+$/, "");
  const apiKey = normalizeText(config?.apiKey);
  if (!baseUrl || !apiKey) {
    throw new Error("LLM config requires baseUrl and apiKey");
  }
  const url = `${baseUrl}${request.endpoint}`;
  const maxRetries = parseNonNegativeInteger(config?.llmMaxRetries, 2);
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeoutMs = parsePositiveInteger(config?.llmTimeoutMs, 120000);
    const timer = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages: request.messages,
          temperature: request.temperature
        }),
        signal: controller?.signal
      });
      if (response.ok) {
        return response.json();
      }
      const error = new Error(`LLM request failed: ${response.status} ${response.statusText}`);
      error.status = response.status;
      lastError = error;
      if (!isRetriableStatus(response.status) || attempt >= maxRetries) {
        throw error;
      }
    } catch (error) {
      lastError = normalizeFetchError(error, attempt, maxRetries);
      if (!shouldRetryError(error) || attempt >= maxRetries) {
        throw lastError;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || new Error("LLM request failed");
}

function extractResponseContent(response) {
  if (typeof response === "string") return response;
  if (response?.content) return response.content;
  const messageContent = response?.choices?.[0]?.message?.content;
  if (Array.isArray(messageContent)) {
    return messageContent
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        return "";
      })
      .join("\n");
  }
  if (messageContent) return messageContent;
  return JSON.stringify(response || {});
}

function normalizeDecision(content, mode) {
  const parsed = parseJsonObjectContent(content);
  const decision = normalizeDecisionValue(parsed.decision);
  const postAction = normalizeText(parsed.post_action);
  if (!["pass", "fail"].includes(decision)) {
    throw new Error(`Invalid LLM decision: ${decision || "(empty)"}`);
  }
  const schema = MODE_SCHEMAS[mode];
  if (!schema.postActions.includes(postAction)) {
    throw new Error(`Invalid LLM post_action for ${mode}: ${postAction || "(empty)"}`);
  }
  return {
    decision,
    post_action: postAction
  };
}

function buildSchemaRepairRequest({
  request,
  mode,
  invalidContent,
  errorMessage
}) {
  const schema = MODE_SCHEMAS[mode];
  return {
    ...request,
    messages: [
      ...request.messages,
      {
        role: "assistant",
        content: String(invalidContent || "").slice(0, 1200)
      },
      {
        role: "user",
        content: [
          `Your previous response violated the schema: ${errorMessage}.`,
          "Return only this JSON shape with enum values exactly as written:",
          JSON.stringify({
            decision: ["pass", "fail"],
            post_action: schema.postActions
          }),
          "No reasons, no labels, no aliases, no markdown."
        ].join(" ")
      }
    ]
  };
}

function normalizeDecisionValue(value) {
  const decision = normalizeText(value).toLowerCase();
  if (decision === "accept" || decision === "accepted" || decision === "qualified" || decision === "yes") {
    return "pass";
  }
  if (decision === "reject" || decision === "rejected" || decision === "unqualified" || decision === "no") {
    return "fail";
  }
  return decision;
}

function isRetriableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function shouldRetryError(error) {
  if (typeof error?.status === "number") return isRetriableStatus(error.status);
  return true;
}

function normalizeFetchError(error, attempt, maxRetries) {
  if (error?.name === "AbortError") {
    return new Error(`LLM request timed out${attempt < maxRetries ? ", retrying" : ""}`);
  }
  return error;
}

function parseJsonObjectContent(content) {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content;
  }
  const raw = String(content || "").trim();
  if (!raw) {
    throw new Error("LLM response is empty");
  }
  const candidates = [raw];
  const fencedMatches = raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fencedMatches) {
    const candidate = String(match?.[1] || "").trim();
    if (candidate) candidates.push(candidate);
  }
  const extractedObject = extractFirstJsonObject(raw);
  if (extractedObject) candidates.push(extractedObject);
  for (const candidate of dedupeStrings(candidates)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Continue trying other candidates.
    }
  }
  throw new Error(`LLM response is not valid JSON object: ${truncateText(raw, 200)}`);
}

function extractFirstJsonObject(text) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

function dedupeStrings(values) {
  const seen = new Set();
  const deduped = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
