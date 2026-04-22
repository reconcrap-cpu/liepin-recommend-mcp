import { readScreeningConfig } from "./config.js";
import { runStructuredScreening, SCREENING_MODES } from "./llm-adapter.js";
import { normalizeText, sha1, toIsoNow } from "./utils.js";

export const PROVIDER_CHECK_MODES = {
  BOTH: "both",
  RECOMMEND: SCREENING_MODES.RECOMMEND,
  CHAT: SCREENING_MODES.CHAT
};

export async function runProviderCheck({
  workspaceRoot,
  mode = PROVIDER_CHECK_MODES.BOTH,
  config = null,
  provider = null,
  fetchImpl = globalThis.fetch
} = {}) {
  const modes = normalizeProviderCheckModes(mode);
  const configResolution = config
    ? { ok: true, config, configPath: null }
    : readScreeningConfig(workspaceRoot);

  if (!configResolution.ok) {
    const check = {
      key: "screening_config",
      ok: false,
      mode: "config",
      code: configResolution.error?.code || "SCREENING_CONFIG_INVALID",
      message: configResolution.error?.message || "screening-config.json is invalid",
      path: configResolution.configPath || ""
    };
    return buildProviderCheckResult({
      modes,
      configResolution,
      checks: [check],
      skipped: true
    });
  }

  const checks = [];
  for (const currentMode of modes) {
    const started = Date.now();
    try {
      const screening = await runStructuredScreening({
        mode: currentMode,
        screenInput: buildSyntheticScreenInput(currentMode),
        config: configResolution.config,
        provider,
        fetchImpl
      });
      checks.push({
        key: `llm_provider_${currentMode}`,
        ok: true,
        mode: currentMode,
        model: configResolution.config.model,
        decision: screening.decision,
        responseContract: screening.request.response_contract,
        reasoningCaptured: screening.reasoningCaptured,
        durationMs: Date.now() - started
      });
    } catch (error) {
      checks.push({
        key: `llm_provider_${currentMode}`,
        ok: false,
        mode: currentMode,
        model: configResolution.config.model,
        code: "LLM_PROVIDER_CHECK_FAILED",
        message: error?.message || "LLM provider check failed",
        durationMs: Date.now() - started
      });
    }
  }

  return buildProviderCheckResult({
    modes,
    configResolution,
    checks,
    skipped: false
  });
}

export function summarizeProviderCheck(result = {}) {
  const checks = Array.isArray(result.checks) ? result.checks : [];
  return {
    ok: Boolean(result.ok),
    skipped: Boolean(result.skipped),
    checkedModes: result.checkedModes || [],
    passedModes: checks.filter((check) => check.ok && check.mode !== "config").map((check) => check.mode),
    failedModes: checks.filter((check) => !check.ok && check.mode !== "config").map((check) => check.mode),
    configReady: Boolean(result.configReady),
    model: result.model || null
  };
}

export function buildSyntheticScreenInput(mode) {
  const normalizedMode = normalizeProviderCheckModes(mode)[0];
  const schemaVersion = normalizedMode === SCREENING_MODES.CHAT
    ? "liepin_chat_screen_input_v1"
    : "liepin_screen_input_v1";
  const payloadText = normalizedMode === SCREENING_MODES.CHAT
    ? [
      "[section:0:chat_state:聊天状态]",
      "候选人当前按钮状态：索要简历。",
      "[section:1:candidate_summary:候选人摘要]",
      "候选人具备 HR 实习经历，本科在读，期望人力资源方向。"
    ].join("\n")
    : [
      "[section:0:job_match:推荐职位]",
      "推荐职位：HR 实习生。",
      "[section:1:job_intent:求职意向]",
      "期望城市：上海；期望方向：人力资源。",
      "[section:2:education:教育经历]",
      "本科在读，工商管理相关专业。"
    ].join("\n");
  const payloadHash = sha1(payloadText);
  return {
    schemaVersion,
    candidate: {
      label: `P25 synthetic ${normalizedMode} candidate`
    },
    manifest: {
      source: "synthetic_provider_check",
      payloadHash,
      payloadCharCount: payloadText.length,
      sectionHashes: [
        {
          ordinal: 0,
          id: normalizedMode === SCREENING_MODES.CHAT ? "chat_state" : "job_match",
          hash: sha1(payloadText.split("\n").slice(0, 2).join("\n"))
        }
      ],
      missingRequiredSourceIds: []
    },
    payloadText
  };
}

function buildProviderCheckResult({
  modes,
  configResolution,
  checks,
  skipped
}) {
  const result = {
    ok: !skipped && checks.every((check) => check.ok),
    skipped,
    checkedAt: toIsoNow(),
    provider: "openai_compatible",
    checkedModes: modes,
    configReady: Boolean(configResolution.ok),
    configPath: configResolution.configPath || "",
    model: configResolution.config?.model || null,
    checks,
    recommendations: buildProviderCheckRecommendations({ configResolution, checks, skipped })
  };
  return {
    ...result,
    summary: summarizeProviderCheck(result)
  };
}

function buildProviderCheckRecommendations({ configResolution, checks, skipped }) {
  if (skipped || !configResolution.ok) {
    return [
      {
        code: configResolution.error?.code || "SCREENING_CONFIG_REQUIRED",
        severity: "warning",
        message: configResolution.error?.message || "Fill screening-config.json before provider check.",
        path: configResolution.configPath || ""
      }
    ];
  }
  if (checks.every((check) => check.ok)) return [];
  return checks.filter((check) => !check.ok).map((check) => ({
    code: check.code || "LLM_PROVIDER_CHECK_FAILED",
    severity: "error",
    mode: check.mode,
    message: check.message
  }));
}

function normalizeProviderCheckModes(mode) {
  const normalized = normalizeText(mode).toLowerCase() || PROVIDER_CHECK_MODES.BOTH;
  if (normalized === PROVIDER_CHECK_MODES.BOTH) {
    return [SCREENING_MODES.RECOMMEND, SCREENING_MODES.CHAT];
  }
  if ([SCREENING_MODES.RECOMMEND, SCREENING_MODES.CHAT].includes(normalized)) {
    return [normalized];
  }
  throw new Error(`Unsupported provider check mode: ${mode}`);
}
