import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_DEBUG_PORT,
  ENV_DEBUG_PORT,
  getStateHome,
  RESEARCH_FILES,
} from "./constants.js";
import { ensureDirSync, normalizeText, parsePositiveInteger, readJsonFile, writeJsonFile } from "./utils.js";

export function getWorkspaceRoot() {
  return process.env.LIEPIN_WORKSPACE_ROOT
    ? path.resolve(process.env.LIEPIN_WORKSPACE_ROOT)
    : path.resolve(process.cwd());
}

export function resolveRuntimeLayout(workspaceRoot = getWorkspaceRoot()) {
  const stateHome = getStateHome();
  const runsDir = path.join(stateHome, "runs");
  const logsDir = path.join(stateHome, "logs");
  const researchDir = path.join(stateHome, "research");
  const configPath = resolveScreeningConfigPath(workspaceRoot);
  return {
    workspaceRoot: path.resolve(workspaceRoot),
    stateHome,
    runsDir,
    logsDir,
    researchDir,
    configPath,
    directories: [stateHome, runsDir, logsDir, researchDir]
  };
}

export function ensureRuntimeLayout(workspaceRoot = getWorkspaceRoot()) {
  const layout = resolveRuntimeLayout(workspaceRoot);
  for (const directory of layout.directories) {
    ensureDirSync(directory);
  }
  return layout;
}

export function resolveScreeningConfigPath(workspaceRoot = getWorkspaceRoot()) {
  void workspaceRoot;
  return path.join(getStateHome(), "screening-config.json");
}

export function validateScreeningConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {
      ok: false,
      message: "screening-config.json 缺失或格式无效，请填写 baseUrl、apiKey、model。"
    };
  }
  const baseUrl = normalizeText(config.baseUrl);
  const apiKey = normalizeText(config.apiKey);
  const model = normalizeText(config.model);
  const missing = [];
  if (!baseUrl) missing.push("baseUrl");
  if (!apiKey) missing.push("apiKey");
  if (!model) missing.push("model");
  if (missing.length > 0) {
    return {
      ok: false,
      message: `screening-config.json 缺少必填字段：${missing.join(", ")}`
    };
  }
  const placeholderFields = [];
  if (isTemplateBaseUrl(baseUrl)) placeholderFields.push("baseUrl");
  if (isTemplateApiKey(apiKey)) placeholderFields.push("apiKey");
  if (isTemplateModel(model)) placeholderFields.push("model");
  if (placeholderFields.length > 0) {
    return {
      ok: false,
      message: `screening-config.json 仍包含模板占位值：${placeholderFields.join(", ")}`
    };
  }
  return { ok: true };
}

function isTemplateBaseUrl(value) {
  const normalized = normalizeComparableUrl(value);
  return (
    normalized === "https://your-llm-endpoint.example.com/v1"
    || normalized.includes("your-llm-endpoint.example.com")
  );
}

function isTemplateApiKey(value) {
  const normalized = normalizeText(value);
  return /^replace-with/i.test(normalized) || /^your-api-key$/i.test(normalized);
}

function isTemplateModel(value) {
  const normalized = normalizeText(value);
  return /^your-model-name$/i.test(normalized) || /^replace-with/i.test(normalized);
}

function normalizeComparableUrl(value) {
  return normalizeText(value).replace(/\/+$/, "").toLowerCase();
}

export function getScreeningConfigResolution(workspaceRoot = getWorkspaceRoot()) {
  const configPath = resolveScreeningConfigPath(workspaceRoot);
  const exists = fs.existsSync(configPath);
  const parsed = exists ? readJsonFile(configPath, null) : null;
  const validation = validateScreeningConfig(parsed);
  return {
    configPath,
    exists,
    writableDir: path.dirname(configPath),
    parsed,
    validation
  };
}

export function readScreeningConfig(workspaceRoot = getWorkspaceRoot()) {
  const resolution = getScreeningConfigResolution(workspaceRoot);
  if (!resolution.exists) {
    return {
      ok: false,
      error: {
        code: "SCREENING_CONFIG_MISSING",
        message: `screening-config.json 不存在，请在 ${resolution.configPath} 填写真实 baseUrl/apiKey/model。`
      },
      ...resolution
    };
  }
  if (!resolution.validation.ok) {
    return {
      ok: false,
      error: {
        code: "SCREENING_CONFIG_INVALID",
        message: `${resolution.validation.message} (path: ${resolution.configPath})`
      },
      ...resolution
    };
  }
  const parsed = resolution.parsed;
  return {
    ok: true,
    config: {
      baseUrl: normalizeText(parsed.baseUrl).replace(/\/+$/, ""),
      apiKey: normalizeText(parsed.apiKey),
      model: normalizeText(parsed.model),
      debugPort: resolveDefaultDebugPort(workspaceRoot),
      reasoningEffort: normalizeText(
        parsed.reasoningEffort
        || parsed.reasoning_effort
        || parsed.llmThinkingLevel
        || parsed.thinkingLevel
      ) || null,
      reasoningEnabled: parseOptionalBoolean(firstDefined(
        parsed.reasoningEnabled,
        parsed.enableReasoning,
        parsed.thinkingEnabled,
        parsed.enableThinking,
        parsed.llmThinkingEnabled
      )),
      reasoningStream: parseOptionalBoolean(firstDefined(
        parsed.reasoningStream,
        parsed.streamReasoning,
        parsed.llmStream
      )),
      llmExtraBody: normalizeObject(firstDefined(
        parsed.llmExtraBody,
        parsed.extraBody,
        parsed.providerExtraBody,
        parsed.openaiCompatibleExtraBody
      )),
      llmTimeoutMs: parsePositiveInteger(parsed.llmTimeoutMs, 120000),
      llmMaxRetries: parsePositiveInteger(parsed.llmMaxRetries, 2),
      llmSchemaMaxRetries: parsePositiveInteger(parsed.llmSchemaMaxRetries, 1)
    },
    ...resolution
  };
}

export function resolveDefaultDebugPort(workspaceRoot = getWorkspaceRoot()) {
  const envPort = parsePositiveInteger(process.env[ENV_DEBUG_PORT], null);
  if (envPort) return envPort;
  const resolution = getScreeningConfigResolution(workspaceRoot);
  const configPort = parsePositiveInteger(resolution.parsed?.debugPort, null);
  return configPort || DEFAULT_DEBUG_PORT;
}

export function createScreeningConfigTemplate() {
  return {
    baseUrl: "https://your-llm-endpoint.example.com/v1",
    apiKey: "replace-with-real-api-key",
    model: "your-model-name",
    debugPort: DEFAULT_DEBUG_PORT,
    reasoningEnabled: true,
    reasoningEffort: "medium",
    reasoningStream: true,
    llmExtraBody: {},
    llmTimeoutMs: 120000,
    llmMaxRetries: 2
  };
}

export function writeScreeningConfigTemplate(workspaceRoot = getWorkspaceRoot(), {
  overwrite = false
} = {}) {
  const resolution = getScreeningConfigResolution(workspaceRoot);
  if (resolution.exists && !overwrite) {
    return {
      ok: true,
      changed: false,
      path: resolution.configPath,
      message: "screening-config.json already exists"
    };
  }
  writeJsonFile(resolution.configPath, createScreeningConfigTemplate());
  return {
    ok: true,
    changed: true,
    path: resolution.configPath,
    message: "screening-config.json template written"
  };
}

export function getResearchDocPaths(workspaceRoot = getWorkspaceRoot()) {
  const root = path.resolve(workspaceRoot);
  return Object.fromEntries(
    Object.entries(RESEARCH_FILES).map(([key, relativePath]) => [key, path.join(root, relativePath)])
  );
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  const normalized = normalizeText(value).toLowerCase();
  if (["true", "1", "yes", "y", "on", "enabled", "enable"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off", "disabled", "disable"].includes(normalized)) return false;
  return null;
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
