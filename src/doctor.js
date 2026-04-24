import module from "node:module";

import { DEFAULT_DEBUG_PORT } from "./constants.js";
import {
  ensureRuntimeLayout,
  getScreeningConfigResolution,
  readScreeningConfig,
  writeScreeningConfigTemplate
} from "./config.js";
import { runChromeDiscovery } from "./liepin/discovery.js";
import { runProviderCheck } from "./provider-check.js";

const require = module.createRequire(import.meta.url);

export async function runDoctor({
  workspaceRoot,
  port = DEFAULT_DEBUG_PORT,
  fix = false,
  providerCheck = false,
  requireChatPage = false
} = {}) {
  const layout = ensureRuntimeLayout(workspaceRoot);
  const fixes = [];
  if (fix) {
    const resolution = getScreeningConfigResolution(workspaceRoot);
    if (!resolution.exists) {
      fixes.push({
        key: "screening_config_template",
        ...writeScreeningConfigTemplate(workspaceRoot)
      });
    }
  }

  const checks = [];
  const puppeteerInstalled = isPackageResolvable("puppeteer-core");

  checks.push({
    key: "node_cli",
    ok: true,
    message: `Node ${process.version}`
  });

  checks.push({
    key: "npm_dep_puppeteer_core",
    ok: puppeteerInstalled,
    message: puppeteerInstalled ? "puppeteer-core installed" : "puppeteer-core missing"
  });

  const screenConfig = readScreeningConfig(workspaceRoot);
  checks.push({
    key: "screening_config",
    ok: screenConfig.ok,
    path: screenConfig.configPath,
    message: screenConfig.ok ? "screening-config.json usable" : screenConfig.error.message
  });

  const providerCheckResult = providerCheck
    ? await runProviderCheck({ workspaceRoot })
    : null;
  if (providerCheckResult) {
    for (const check of providerCheckResult.checks || []) {
      checks.push({
        key: check.key,
        ok: check.ok,
        mode: check.mode,
        model: check.model,
        message: check.ok
          ? `LLM provider ${check.mode} check passed`
          : check.message
      });
    }
  }

  const chrome = await runChromeDiscovery({ port });
  checks.push({
    key: "chrome_9222",
    ok: chrome.ok,
    message: chrome.ok ? `Chrome reachable on ${port}` : chrome.error.message
  });

  if (chrome.ok) {
    checks.push({
      key: "liepin_risk_page",
      ok: !chrome.riskBlocked,
      message: chrome.riskBlocked
        ? `检测到猎聘风控/验证码页：${chrome.pages.riskPage?.url || "unknown"}`
        : chrome.riskPageDetected
          ? `检测到旧的猎聘风控/验证码 tab，但当前 recommend page 可用：${chrome.pages.riskPage?.url || "unknown"}`
          : "No Liepin risk/captcha page detected"
    });
    checks.push({
      key: "liepin_recommend_page",
      ok: Boolean(chrome.pages.recommend),
      message: chrome.pages.recommend ? chrome.pages.recommend.url : "Recommend page not found"
    });
    checks.push({
      key: "liepin_chat_page",
      ok: Boolean(chrome.pages.chat) || !requireChatPage,
      required: Boolean(requireChatPage),
      found: Boolean(chrome.pages.chat),
      message: chrome.pages.chat
        ? chrome.pages.chat.url
        : requireChatPage
          ? "Chat page not found"
          : "Chat page not found; required only for chat-only workflows"
    });
  }

  const recommendations = buildDoctorRecommendations({
    checks,
    chrome,
    screenConfig,
    layout,
    port,
    requireChatPage
  });

  return {
    ok: checks.every((item) => item.ok),
    checks,
    recommendations,
    fixes,
    runtimeLayout: layout,
    install: buildInstallHints({ layout, port }),
    screenConfigPath: getScreeningConfigResolution(workspaceRoot).configPath,
    providerCheck: providerCheckResult,
    chrome: chrome.ok ? chrome : { ok: false, error: chrome.error }
  };
}

export function buildDoctorRecommendations({
  checks = [],
  chrome = null,
  screenConfig = null,
  layout = null,
  port = DEFAULT_DEBUG_PORT,
  requireChatPage = false
} = {}) {
  const byKey = new Map(checks.map((check) => [check.key, check]));
  const recommendations = [];
  if (byKey.get("npm_dep_puppeteer_core")?.ok === false) {
    recommendations.push({
      code: "INSTALL_DEPENDENCIES",
      severity: "error",
      message: "Install npm dependencies before running browser workflows.",
      command: "npm install"
    });
  }
  if (screenConfig?.ok === false) {
    recommendations.push({
      code: screenConfig.exists ? "FIX_SCREENING_CONFIG" : "CREATE_SCREENING_CONFIG",
      severity: "warning",
      message: screenConfig.exists
        ? "Update screening-config.json with real baseUrl, apiKey, and model."
        : "Create screening-config.json, then fill baseUrl, apiKey, and model.",
      path: screenConfig.configPath || layout?.configPath || "",
      command: screenConfig.exists ? "" : "node src/cli.js doctor --fix"
    });
  }
  const failedProviderChecks = checks.filter((check) => (
    check.key?.startsWith("llm_provider_") && check.ok === false
  ));
  if (failedProviderChecks.length > 0) {
    recommendations.push({
      code: "CHECK_LLM_PROVIDER",
      severity: "error",
      message: "LLM provider readiness check failed; inspect provider check output before real-provider e2e.",
      command: "node src/cli.js provider check"
    });
  }
  if (chrome?.ok === false) {
    recommendations.push({
      code: "START_CHROME_DEBUG",
      severity: "error",
      message: `Start Chrome with remote debugging on port ${port}.`,
      command: `chrome --remote-debugging-port=${port}`
    });
  }
  if (chrome?.ok && chrome.riskBlocked) {
    recommendations.push({
      code: "RESOLVE_LIEPIN_RISK",
      severity: "error",
      message: "Resolve the active Liepin captcha/risk page before running live workflows.",
      url: chrome.pages?.riskPage?.url || ""
    });
  }
  if (chrome?.ok && !chrome.pages?.recommend) {
    recommendations.push({
      code: "OPEN_RECOMMEND_PAGE",
      severity: "warning",
      message: `Open the Liepin recommend page in the Chrome ${port} session.`,
      url: "https://lpt.liepin.com/recommend"
    });
  }
  if (chrome?.ok && !chrome.pages?.chat) {
    recommendations.push({
      code: "OPEN_CHAT_PAGE_IF_NEEDED",
      severity: requireChatPage ? "error" : "info",
      message: `Open the Liepin chat page in the Chrome ${port} session before chat-only workflows.`,
      url: "https://lpt.liepin.com/chat/im"
    });
  }
  return recommendations;
}

function buildInstallHints({ layout, port }) {
  return {
    package: "npm install",
    mcpServer: "node src/index.js",
    doctor: `node src/cli.js doctor --debug-port ${port}`,
    selfHeal: "node src/cli.js doctor --fix",
    configPath: layout?.configPath || "",
    runtimeHome: layout?.stateHome || ""
  };
}

function isPackageResolvable(specifier) {
  try {
    return Boolean(require.resolve(specifier));
  } catch {
    return false;
  }
}
