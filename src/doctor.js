import { spawnSync } from "node:child_process";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_DEBUG_PORT } from "./constants.js";
import {
  ensureChromeDebugPort,
  ensureLiepinTargetPage,
  getLiepinTargetUrl,
} from "./chrome.js";
import {
  ensureRuntimeLayout,
  getScreeningConfigResolution,
  readScreeningConfig,
  writeScreeningConfigTemplate
} from "./config.js";
import { runChromeDiscovery } from "./liepin/discovery.js";
import { runProviderCheck } from "./provider-check.js";

const require = module.createRequire(import.meta.url);
const currentFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFilePath), "..");

export async function runDoctor({
  workspaceRoot,
  port = DEFAULT_DEBUG_PORT,
  fix = false,
  autoFix = null,
  providerCheck = false,
  requireChatPage = false,
  targetPage = null,
  requireScreeningConfig = true
} = {}) {
  const layout = ensureRuntimeLayout(workspaceRoot);
  const shouldFix = Boolean(autoFix ?? fix);
  const resolvedTargetPage = normalizeDoctorTargetPage(targetPage, requireChatPage);
  const fixes = [];
  if (shouldFix) {
    const resolution = getScreeningConfigResolution(workspaceRoot);
    if (!resolution.exists) {
      fixes.push({
        key: "screening_config_template",
        ...writeScreeningConfigTemplate(workspaceRoot)
      });
    }
  }

  const checks = [];
  let puppeteerInstalled = isPackageResolvable("puppeteer-core");

  if (shouldFix && !puppeteerInstalled) {
    const dependencyFix = installNpmDependencies();
    fixes.push({
      key: "npm_dependencies",
      ...dependencyFix
    });
    puppeteerInstalled = isPackageResolvable("puppeteer-core");
  }

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
    ok: screenConfig.ok || !requireScreeningConfig,
    required: Boolean(requireScreeningConfig),
    path: screenConfig.configPath,
    message: screenConfig.ok
      ? "screening-config.json usable"
      : requireScreeningConfig
        ? screenConfig.error.message
        : `${screenConfig.error.message}（当前检查不强制要求 LLM 配置）`
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

  let chromeGuard = null;
  let chrome = null;
  if (shouldFix) {
    chromeGuard = await ensureChromeDebugPort({
      port,
      url: getLiepinTargetUrl(resolvedTargetPage),
      userDataDir: path.join(layout.stateHome, `chrome-debug-profile-${port}`)
    });
    if (chromeGuard.launched || chromeGuard.replaced || !chromeGuard.ok) {
      fixes.push({
        key: chromeGuard.replaced ? "chrome_required_flags" : "chrome_debug",
        ok: chromeGuard.ok,
        changed: Boolean(chromeGuard.launched || chromeGuard.replaced),
        port,
        targetPage: resolvedTargetPage,
        chromeGuard
      });
    }
    chrome = await runChromeDiscovery({ port });
  } else {
    chrome = await runChromeDiscovery({ port });
    if (chrome.ok) {
      chromeGuard = await ensureChromeDebugPort({
        port,
        url: getLiepinTargetUrl(resolvedTargetPage),
        launchIfMissing: false,
        autoReplace: false
      });
    }
  }

  checks.push({
    key: "chrome_required_flags",
    ok: Boolean(chromeGuard?.requiredFlagsOk),
    requiredFlags: chromeGuard?.requiredFlags || [],
    missingFlags: chromeGuard?.missingFlags || [],
    replaced: Boolean(chromeGuard?.replaced),
    launched: Boolean(chromeGuard?.launched),
    closeMethod: chromeGuard?.closeMethod || null,
    relaunch: chromeGuard?.relaunch || null,
    message: chromeGuard?.requiredFlagsOk
      ? chromeGuard.replaced
        ? `Chrome ${port} 缺少必需 flags，已自动关闭并用正确 flags 重新启动。`
        : chromeGuard.launched
          ? `Chrome ${port} 已用必需 flags 启动。`
          : `Chrome ${port} 已确认包含必需 flags。`
      : chromeGuard
        ? `Chrome ${port} 未确认包含必需 flags：${chromeGuard.missingFlags?.join(", ") || chromeGuard.error?.message || chromeGuard.reason || "unknown"}`
        : `Chrome ${port} 未确认包含必需 flags。`
  });

  if (shouldFix && !chrome.ok && chromeGuard?.ok) {
    chrome = await runChromeDiscovery({ port });
  }

  if (
    shouldFix
    && chrome.ok
    && resolvedTargetPage
    && !chrome.pages?.[resolvedTargetPage]
    && !chrome.riskBlocked
  ) {
    const navigation = await ensureLiepinTargetPage({
      port,
      targetPage: resolvedTargetPage
    });
    fixes.push({
      key: "liepin_target_page",
      ok: navigation.ok,
      changed: navigation.changed,
      targetPage: resolvedTargetPage,
      url: getLiepinTargetUrl(resolvedTargetPage),
      navigation
    });
    chrome = await runChromeDiscovery({ port });
  }

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
          ? `检测到旧的猎聘风控/验证码 tab，但当前目标页可用：${chrome.pages.riskPage?.url || "unknown"}`
          : "No Liepin risk/captcha page detected"
    });
    checks.push({
      key: "liepin_login",
      ok: Boolean(chrome.loginOk),
      message: chrome.loginOk
        ? "Liepin session detected"
        : `未检测到猎聘登录会话；请在 Chrome ${port} 完成猎聘登录。`
    });
    checks.push({
      key: `liepin_${resolvedTargetPage}_page`,
      ok: Boolean(chrome.pages?.[resolvedTargetPage]),
      required: true,
      found: Boolean(chrome.pages?.[resolvedTargetPage]),
      targetPage: resolvedTargetPage,
      url: getLiepinTargetUrl(resolvedTargetPage),
      message: chrome.pages?.[resolvedTargetPage]
        ? chrome.pages[resolvedTargetPage].url
        : `${capitalizeAscii(resolvedTargetPage)} page not found`
    });
  }

  const recommendations = buildDoctorRecommendations({
    checks,
    chrome,
    screenConfig,
    layout,
    port,
    requireChatPage,
    targetPage: resolvedTargetPage,
    requireScreeningConfig
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
    targetPage: resolvedTargetPage,
    chrome: chrome.ok ? chrome : { ok: false, error: chrome.error },
    chromeGuard
  };
}

export function buildDoctorRecommendations({
  checks = [],
  chrome = null,
  screenConfig = null,
  layout = null,
  port = DEFAULT_DEBUG_PORT,
  requireChatPage = false,
  targetPage = "recommend",
  requireScreeningConfig = true
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
      severity: requireScreeningConfig ? "warning" : "info",
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
  const chromeFlagsCheck = byKey.get("chrome_required_flags");
  if (chrome?.ok && chromeFlagsCheck?.ok === false) {
    recommendations.push({
      code: "FIX_CHROME_REQUIRED_FLAGS",
      severity: "error",
      message: `Chrome ${port} is reachable but was not launched with Liepin MCP required anti-throttling flags.`,
      command: `node src/cli.js doctor --fix --target-page ${normalizeDoctorTargetPage(targetPage, requireChatPage)} --debug-port ${port}`
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
  const normalizedTargetPage = normalizeDoctorTargetPage(targetPage, requireChatPage);
  if (chrome?.ok && !chrome.loginOk && !chrome.riskBlocked) {
    recommendations.push({
      code: "LOGIN_LIEPIN",
      severity: "error",
      message: `Chrome ${port} 已打开猎聘目标页；请在该浏览器里完成猎聘登录，然后重试。`,
      url: getLiepinTargetUrl(normalizedTargetPage)
    });
  }
  if (chrome?.ok && chrome.loginOk && !chrome.pages?.[normalizedTargetPage] && !chrome.riskBlocked) {
    recommendations.push({
      code: "OPEN_TARGET_PAGE",
      severity: "warning",
      message: `Open or navigate to the Liepin ${normalizedTargetPage} page in the Chrome ${port} session.`,
      url: getLiepinTargetUrl(normalizedTargetPage),
      command: `node src/cli.js doctor --fix --target-page ${normalizedTargetPage} --debug-port ${port}`
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

function installNpmDependencies() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["install"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    timeout: 120000
  });
  return {
    ok: result.status === 0,
    changed: result.status === 0,
    command: "npm install",
    cwd: packageRoot,
    status: result.status,
    message: result.status === 0
      ? "npm dependencies installed"
      : (result.error?.message || result.stderr || result.stdout || "npm install failed").trim()
  };
}

function normalizeDoctorTargetPage(targetPage, requireChatPage = false) {
  const normalized = String(targetPage || "").trim().toLowerCase();
  if (normalized === "chat" || requireChatPage) return "chat";
  if (normalized === "search") return "search";
  return "recommend";
}

function capitalizeAscii(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "";
}
