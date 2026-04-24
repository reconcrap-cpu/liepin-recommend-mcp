import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "liepin-mcp";
export const SERVER_VERSION = "0.1.0";
export const DEFAULT_DEBUG_PORT = 9222;
export const DEFAULT_TARGET_SURVEY_MIN = 50;
export const DEFAULT_TARGET_SURVEY_BATCH = 10;
export const DEFAULT_TARGET_SURVEY_PER_PASS = 10;
export const DEFAULT_TARGET_SURVEY_MAX_ROUNDS = 4;
export const DEFAULT_RECOMMEND_SAMPLE_LIMIT = 5;
export const DEFAULT_RECOMMEND_STEP_DELAY_MS = 3500;
export const DEFAULT_CHAT_SAMPLE_LIMIT = 5;
export const ENV_HOME = "LIEPIN_RECOMMEND_HOME";
export const ENV_CONFIG = "LIEPIN_RECOMMEND_CONFIG";
export const ENV_DEBUG_PORT = "LIEPIN_DEBUG_PORT";
export const STATE_HOME = path.join(os.homedir(), ".liepin-recommend-mcp");

export function getStateHome() {
  return process.env[ENV_HOME]
    ? path.resolve(process.env[ENV_HOME])
    : STATE_HOME;
}

export const RUN_STATES = {
  QUEUED: "queued",
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELED: "canceled"
};

export const RUN_KINDS = {
  RECOMMEND: "recommend",
  CHAT: "chat",
  RECOMMEND_CHAT: "recommend-chat",
  SEARCH: "search"
};

export const RUN_WORKFLOWS = {
  RECOMMEND_SAMPLE: "recommend_sample",
  CHAT_SAMPLE: "chat_sample",
  CV_SURVEY: "cv_survey",
  RECOMMEND_DRY_RUN_SCREENING: "recommend_dry_run_screening",
  CHAT_DRY_RUN_SCREENING: "chat_dry_run_screening",
  RECOMMEND_CHAT_CHAIN: "recommend_chat_chain",
  SEARCH_CHAT_CHAIN: "search_chat_chain"
};

export const TERMINAL_RUN_STATES = new Set([
  RUN_STATES.COMPLETED,
  RUN_STATES.FAILED,
  RUN_STATES.CANCELED
]);

export const LIEPIN_URLS = {
  recommend: "https://lpt.liepin.com/recommend",
  search: "https://lpt.liepin.com/search",
  chat: "https://lpt.liepin.com/chat/im",
  resumeDetailFragment: "/resume/detail",
  safeHost: "safe.liepin.com",
  captchaFragment: "captchaPage"
};

export const TOOL_NAMES = {
  doctor: "liepin_doctor",
  install: "liepin_install",
  selfHeal: "liepin_self_heal",
  skillExport: "liepin_skill_export",
  externalAgentConfig: "liepin_external_agent_config",
  providerCheck: "liepin_provider_check",
  recommendFilterOptions: "liepin_recommend_filter_options",
  searchOptions: "liepin_search_options",
  recommendStart: "liepin_recommend_start",
  searchStart: "liepin_search_start",
  chatStart: "liepin_chat_start",
  recommendChatStart: "liepin_recommend_chat_start",
  runStatus: "liepin_run_status",
  runPause: "liepin_run_pause",
  runResume: "liepin_run_resume",
  runCancel: "liepin_run_cancel"
};

export const ARTIFACT_FILES = {
  run: "run.json",
  events: "events.ndjson",
  screenInput: "screen-input.json",
  llmRequest: "llm-request.json",
  decision: "decision.json",
  coverage: "coverage.json",
  reasoning: "reasoning.log"
};

export const RESEARCH_FILES = {
  selectorLedger: "docs/liepin-recommend-mcp/research/selector-ledger.md",
  cvTaxonomy: "docs/liepin-recommend-mcp/research/cv-dom-taxonomy.md",
  chatScreenInputTaxonomy: "docs/liepin-recommend-mcp/research/chat-screen-input-taxonomy.md",
  llmCoverageAudit: "docs/liepin-recommend-mcp/research/llm-coverage-audit.md"
};
