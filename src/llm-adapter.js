import fs from "node:fs";
import path from "node:path";

import { ensureDirSync, normalizeText } from "./utils.js";

const DEFAULT_LLM_RETRY_DELAY_MS = 1000;
const DEFAULT_LLM_RATE_LIMIT_RETRY_DELAY_MS = 30000;
const DEFAULT_LLM_RETRY_MAX_DELAY_MS = 120000;

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

const reasoningCompatibilityDowngrades = new Map();

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
  const reasoningFragments = [];
  const onReasoningDelta = (chunk) => {
    const text = String(chunk || "");
    if (!text) return;
    reasoningCaptured = true;
    reasoningFragments.push(text);
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
    const nativeReasoningText = extractNativeReasoningText(response);
    if (nativeReasoningText) {
      reasoningCaptured = true;
      reasoningFragments.push(nativeReasoningText);
      if (reasoningLogPath) {
        ensureDirSync(path.dirname(reasoningLogPath));
        fs.appendFileSync(reasoningLogPath, nativeReasoningText, "utf8");
      }
    }
    const content = extractResponseContent(response);
    try {
      return {
        request: currentRequest,
        decision: normalizeDecision(content, mode),
        reasoningCaptured,
        reasoningText: dedupeStrings(reasoningFragments).join("\n"),
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
  const compatibilityKey = getCompatibilityKey(config);
  const disabledFeatures = getCompatibilityDowngrades(compatibilityKey);
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeoutMs = parsePositiveInteger(config?.llmTimeoutMs, 120000);
    const requestBody = buildOpenAiCompatibleRequestBody({
      config,
      request,
      disabledFeatures
    });
    attachProviderRequestMetadata(request, requestBody, disabledFeatures);
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
        body: JSON.stringify(requestBody),
        signal: controller?.signal
      });
      if (response.ok) {
        return requestBody.stream === true || isStreamResponse(response)
          ? parseOpenAiCompatibleStream(response)
          : response.json();
      }
      const responseText = await readResponseText(response);
      const downgrade = selectCompatibilityDowngrade({
        requestBody,
        response,
        responseText,
        disabledFeatures
      });
      if (downgrade) {
        disabledFeatures[downgrade] = true;
        reasoningCompatibilityDowngrades.set(compatibilityKey, { ...disabledFeatures });
        attempt -= 1;
        continue;
      }
      const error = new Error(`LLM request failed: ${response.status} ${response.statusText}`);
      error.code = response.status === 429 ? "LLM_RATE_LIMITED" : `LLM_HTTP_${response.status}`;
      error.status = response.status;
      error.body = responseText;
      error.retryAfterMs = parseRetryAfterMs(readHeader(response.headers, "retry-after"));
      lastError = error;
      if (!isRetriableStatus(response.status) || attempt >= maxRetries) {
        throw error;
      }
      await waitBeforeLlmRetry({ config, response, error, attempt });
    } catch (error) {
      lastError = normalizeFetchError(error, attempt, maxRetries);
      if (!shouldRetryError(error) || attempt >= maxRetries) {
        throw lastError;
      }
      await waitBeforeLlmRetry({ config, error: lastError, attempt });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || new Error("LLM request failed");
}

function buildOpenAiCompatibleRequestBody({
  config,
  request,
  disabledFeatures = {}
}) {
  const body = {
    model: config.model,
    messages: request.messages,
    temperature: request.temperature
  };
  const reasoningEnabled = shouldRequestReasoning(config);
  if (reasoningEnabled) {
    const reasoningEffort = normalizeText(config?.reasoningEffort);
    if (reasoningEffort && !disabledFeatures.reasoningEffort) {
      body.reasoning_effort = reasoningEffort;
    }
    if (shouldSendThinkingToggle(config) && !disabledFeatures.thinking) {
      body.thinking = resolveThinkingToggle(config);
    }
    if (shouldStreamReasoning(config) && !disabledFeatures.stream) {
      body.stream = true;
    }
  }
  return {
    ...body,
    ...normalizeObject(config?.llmExtraBody)
  };
}

function shouldRequestReasoning(config) {
  if (typeof config?.reasoningEnabled === "boolean") return config.reasoningEnabled;
  return Boolean(normalizeText(config?.reasoningEffort) || Object.keys(normalizeObject(config?.llmExtraBody)).length);
}

function shouldStreamReasoning(config) {
  if (typeof config?.reasoningStream === "boolean") return config.reasoningStream;
  return true;
}

function shouldSendThinkingToggle(config) {
  if (Object.hasOwn(normalizeObject(config?.llmExtraBody), "thinking")) return false;
  const baseUrl = normalizeText(config?.baseUrl).toLowerCase();
  if (baseUrl.includes("api.openai.com") || baseUrl.includes("openai.azure.com")) return false;
  return true;
}

function resolveThinkingToggle(config) {
  if (typeof config?.thinking === "object" && config.thinking !== null && !Array.isArray(config.thinking)) {
    return config.thinking;
  }
  return { type: "enabled" };
}

function getCompatibilityKey(config) {
  return [
    normalizeText(config?.baseUrl).toLowerCase(),
    normalizeText(config?.model).toLowerCase()
  ].join("|");
}

function getCompatibilityDowngrades(key) {
  return {
    reasoningEffort: false,
    thinking: false,
    stream: false,
    ...(reasoningCompatibilityDowngrades.get(key) || {})
  };
}

function selectCompatibilityDowngrade({
  requestBody,
  response,
  responseText,
  disabledFeatures
}) {
  if (![400, 404, 415, 422].includes(response.status)) return null;
  const detail = normalizeText(responseText || response.statusText).toLowerCase();
  const looksLikeParameterError = !detail || /unknown|unrecognized|unsupported|invalid|parameter|argument|field|extra|stream|thinking|reasoning|effort/u.test(detail);
  if (!looksLikeParameterError) return null;
  if (/thinking/u.test(detail) && requestBody.thinking && !disabledFeatures.thinking) return "thinking";
  if (/stream|sse/u.test(detail) && requestBody.stream === true && !disabledFeatures.stream) return "stream";
  if (/reasoning|effort/u.test(detail) && requestBody.reasoning_effort && !disabledFeatures.reasoningEffort) {
    return "reasoningEffort";
  }
  if (requestBody.thinking && !disabledFeatures.thinking) return "thinking";
  if (requestBody.stream === true && !disabledFeatures.stream) return "stream";
  if (requestBody.reasoning_effort && !disabledFeatures.reasoningEffort) return "reasoningEffort";
  return null;
}

function attachProviderRequestMetadata(request, requestBody, disabledFeatures = {}) {
  request.provider_request = {
    endpoint: request.endpoint,
    body_keys: Object.keys(requestBody),
    body: sanitizeProviderRequestBody(requestBody),
    compatibility_downgrades: Object.fromEntries(
      Object.entries(disabledFeatures).filter(([, value]) => value === true)
    )
  };
}

function sanitizeProviderRequestBody(requestBody = {}) {
  const sanitized = {};
  for (const [key, value] of Object.entries(requestBody)) {
    if (key === "messages") {
      sanitized.messages_omitted = true;
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function isStreamResponse(response) {
  const contentType = normalizeText(response?.headers?.get?.("content-type")).toLowerCase();
  return contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson");
}

async function parseOpenAiCompatibleStream(response) {
  const text = await readResponseText(response);
  const chunks = parseStreamChunks(text);
  if (chunks.length === 0) return JSON.parse(text);
  return assembleStreamedChatCompletion(chunks);
}

function parseStreamChunks(text) {
  const chunks = [];
  const blocks = String(text || "").split(/\r?\n\r?\n/u);
  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s*/u, ""));
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") continue;
    try {
      chunks.push(JSON.parse(data));
    } catch {
      // Ignore keepalive or provider-specific non-JSON stream events.
    }
  }
  if (chunks.length > 0) return chunks;
  for (const line of String(text || "").split(/\r?\n/u)) {
    const data = line.trim().replace(/^data:\s*/u, "");
    if (!data || data === "[DONE]") continue;
    try {
      chunks.push(JSON.parse(data));
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return chunks;
}

function assembleStreamedChatCompletion(chunks) {
  const content = [];
  const reasoning = [];
  let finishReason = null;
  let usage = null;
  let model = null;
  for (const chunk of chunks) {
    if (!model && chunk?.model) model = chunk.model;
    if (chunk?.usage) usage = chunk.usage;
    collectResponseApiStreamText(chunk, { content, reasoning });
    const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
    for (const choice of choices) {
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      collectChatChoiceText(choice, { content, reasoning });
    }
  }
  return {
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: {
          role: "assistant",
          content: content.join(""),
          reasoning_content: reasoning.join("")
        }
      }
    ],
    usage
  };
}

function collectChatChoiceText(choice, target) {
  const delta = choice?.delta || {};
  const message = choice?.message || {};
  collectStreamNestedText(delta.content, target.content);
  collectStreamNestedText(message.content, target.content);
  collectStreamNestedText(choice?.reasoning_content, target.reasoning);
  collectStreamNestedText(choice?.reasoning, target.reasoning);
  collectStreamNestedText(delta.reasoning_content, target.reasoning);
  collectStreamNestedText(delta.reasoningContent, target.reasoning);
  collectStreamNestedText(delta.reasoning, target.reasoning);
  collectStreamNestedText(message.reasoning_content, target.reasoning);
  collectStreamNestedText(message.reasoningContent, target.reasoning);
  collectStreamNestedText(message.reasoning, target.reasoning);
}

function collectResponseApiStreamText(chunk, target) {
  const type = normalizeText(chunk?.type).toLowerCase();
  if (type.includes("reasoning")) {
    collectStreamNestedText(chunk?.delta, target.reasoning);
    collectStreamNestedText(chunk?.text, target.reasoning);
    collectStreamNestedText(chunk?.summary, target.reasoning);
  }
  if (type.includes("output_text") || type.includes("content_part")) {
    collectStreamNestedText(chunk?.delta, target.content);
    collectStreamNestedText(chunk?.text, target.content);
  }
  collectStreamNestedText(chunk?.reasoning_content, target.reasoning);
  collectStreamNestedText(chunk?.reasoningContent, target.reasoning);
  collectStreamNestedText(chunk?.reasoning, target.reasoning);
}

async function readResponseText(response) {
  if (typeof response?.text !== "function") return "";
  try {
    return await response.text();
  } catch {
    return "";
  }
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

function extractNativeReasoningText(response) {
  const fragments = [];
  collectNativeReasoning(response, fragments);
  return dedupeStrings(fragments).join("\n");
}

function collectNativeReasoning(value, out = [], depth = 0, keyHint = "") {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (isReasoningKey(keyHint)) {
      const normalized = normalizeText(value);
      if (normalized) out.push(normalized);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNativeReasoning(item, out, depth + 1, keyHint);
    }
    return out;
  }
  if (typeof value !== "object") return out;

  const type = normalizeText(value.type).toLowerCase();
  if (type === "reasoning" || type === "reasoning_content") {
    for (const key of ["text", "content", "summary", "summary_text"]) {
      collectNestedText(value[key], out);
    }
  }

  const directKeys = [
    "reasoning",
    "reasoning_content",
    "reasoningContent",
    "reasoning_details",
    "reasoningDetails",
    "reasoning_summary",
    "reasoningSummary",
    "rawReasoningText",
    "raw_reasoning_text",
    "thinking",
    "thinking_content",
    "thinkingContent",
    "thought",
    "thoughts"
  ];
  for (const key of directKeys) {
    if (Object.hasOwn(value, key)) {
      collectNestedText(value[key], out);
    }
  }

  const choices = Array.isArray(value.choices) ? value.choices : [];
  for (const choice of choices) {
    collectNestedText(choice?.reasoning, out);
    collectNestedText(choice?.reasoning_content, out);
    collectNestedText(choice?.message?.reasoning, out);
    collectNestedText(choice?.message?.reasoning_content, out);
    collectNestedText(choice?.message?.reasoningContent, out);
    collectNestedText(choice?.message?.thinking, out);
    collectNestedText(choice?.message?.thinking_content, out);
    collectNestedText(choice?.message?.thoughts, out);
  }

  const output = Array.isArray(value.output) ? value.output : [];
  for (const item of output) {
    const itemType = normalizeText(item?.type).toLowerCase();
    if (itemType === "reasoning" || itemType === "reasoning_content" || itemType === "thinking") {
      collectNestedText(item, out);
    }
  }
  return out;
}

function collectNestedText(value, out = [], depth = 0) {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = normalizeText(value);
    if (normalized) out.push(normalized);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNestedText(item, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const key of [
      "text",
      "content",
      "summary_text",
      "summary",
      "reasoning_content",
      "reasoningContent",
      "reasoning",
      "thinking_content",
      "thinkingContent",
      "thinking",
      "thought",
      "thoughts"
    ]) {
      if (Object.hasOwn(value, key)) collectNestedText(value[key], out, depth + 1);
    }
  }
  return out;
}

function collectStreamNestedText(value, out = [], depth = 0) {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value);
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStreamNestedText(item, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const key of [
      "text",
      "content",
      "summary_text",
      "summary",
      "delta",
      "reasoning_content",
      "reasoningContent",
      "reasoning",
      "thinking_content",
      "thinkingContent",
      "thinking",
      "thought",
      "thoughts"
    ]) {
      if (Object.hasOwn(value, key)) collectStreamNestedText(value[key], out, depth + 1);
    }
  }
  return out;
}

function isReasoningKey(key) {
  return /reasoning|reasoning_content|raw_reasoning|rawReasoning|thinking|thought/u.test(String(key || ""));
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

async function waitBeforeLlmRetry({
  config,
  response = null,
  error = null,
  attempt = 0
} = {}) {
  const delayMs = computeLlmRetryDelayMs({
    config,
    response,
    error,
    attempt
  });
  if (delayMs <= 0) return;
  if (typeof config?.llmRetrySleep === "function") {
    await config.llmRetrySleep(delayMs);
    return;
  }
  await sleep(delayMs);
}

function computeLlmRetryDelayMs({
  config,
  response = null,
  error = null,
  attempt = 0
} = {}) {
  const status = typeof response?.status === "number" ? response.status : error?.status;
  const retryAfterMs = error?.retryAfterMs ?? parseRetryAfterMs(readHeader(response?.headers, "retry-after"));
  const baseDelayMs = status === 429
    ? parseNonNegativeInteger(config?.llmRateLimitRetryDelayMs, DEFAULT_LLM_RATE_LIMIT_RETRY_DELAY_MS)
    : parseNonNegativeInteger(config?.llmRetryDelayMs, DEFAULT_LLM_RETRY_DELAY_MS);
  const maxDelayMs = parsePositiveInteger(config?.llmRetryMaxDelayMs, DEFAULT_LLM_RETRY_MAX_DELAY_MS);
  const exponentialDelayMs = baseDelayMs * (2 ** Math.max(0, attempt));
  const requestedDelayMs = Math.max(exponentialDelayMs, retryAfterMs || 0);
  return Math.min(maxDelayMs, requestedDelayMs);
}

function readHeader(headers, name) {
  if (!headers || !name) return "";
  if (typeof headers.get === "function") {
    return headers.get(name) || headers.get(name.toLowerCase()) || "";
  }
  const direct = headers[name] || headers[name.toLowerCase()];
  return direct === undefined || direct === null ? "" : String(direct);
}

function parseRetryAfterMs(value, now = Date.now()) {
  const raw = normalizeText(value);
  if (!raw) return 0;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, timestamp - now);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
