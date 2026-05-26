import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_DEBUG_PORT, LIEPIN_URLS } from "./constants.js";
import { normalizeText, parsePositiveInteger, sleep } from "./utils.js";

export const DEFAULT_CDP_CALL_TIMEOUT_MS = 30000;
export const MIN_CDP_WAIT_EVALUATE_TIMEOUT_MS = 1000;
export const REQUIRED_CHROME_DEBUG_FLAGS = [
  "--disable-backgrounding-occluded-windows",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-features=CalculateNativeWinOcclusion"
];

export async function connectToChrome({ port = DEFAULT_DEBUG_PORT } = {}) {
  const resolvedPort = parsePositiveInteger(port, DEFAULT_DEBUG_PORT);
  const browserURL = `http://127.0.0.1:${resolvedPort}`;
  try {
    const version = await getJson(`${browserURL}/json/version`);
    return {
      ok: true,
      browserURL,
      port: resolvedPort,
      version
    };
  } catch (error) {
    return {
      ok: false,
      port: resolvedPort,
      browserURL,
      error: {
        code: "CHROME_CONNECT_FAILED",
        message: `无法连接 Chrome ${browserURL}：${error?.message || "unknown error"}`
      }
    };
  }
}

export async function listTargets({ port = DEFAULT_DEBUG_PORT } = {}) {
  const resolvedPort = parsePositiveInteger(port, DEFAULT_DEBUG_PORT);
  const browserURL = `http://127.0.0.1:${resolvedPort}`;
  return getJson(`${browserURL}/json/list`);
}

export function getLiepinTargetUrl(kind) {
  const normalized = normalizeText(kind).toLowerCase();
  if (normalized === "chat") return LIEPIN_URLS.chat;
  if (normalized === "search") return LIEPIN_URLS.search;
  return LIEPIN_URLS.recommend;
}

export function classifyLiepinPage(url) {
  const normalized = normalizeText(url);
  if (!normalized) return "other";
  if (isLiepinRiskPageUrl(normalized)) return "risk";
  if (normalized.includes(LIEPIN_URLS.recommend)) return "recommend";
  if (normalized.includes(LIEPIN_URLS.search)) return "search";
  if (normalized.includes(LIEPIN_URLS.chat)) return "chat";
  if (normalized.includes(LIEPIN_URLS.resumeDetailFragment)) return "resume_detail";
  return "other";
}

export function isLiepinRiskPageUrl(url) {
  const normalized = normalizeText(url);
  return normalized.includes(LIEPIN_URLS.safeHost)
    || normalized.includes(LIEPIN_URLS.captchaFragment);
}

export async function discoverLiepinPages({ port = DEFAULT_DEBUG_PORT } = {}) {
  const targets = (await listTargets({ port }))
    .filter((target) => target.type === "page");
  const mapped = targets.map((target) => ({
    id: target.id,
    url: target.url,
    title: target.title,
    type: target.type,
    kind: classifyLiepinPage(target.url),
    webSocketDebuggerUrl: target.webSocketDebuggerUrl
  }));
  return {
    recommend: mapped.find((item) => item.kind === "recommend") || null,
    search: mapped.find((item) => item.kind === "search") || null,
    chat: mapped.find((item) => item.kind === "chat") || null,
    resumeDetail: mapped.find((item) => item.kind === "resume_detail") || null,
    riskPage: mapped.find((item) => item.kind === "risk") || null,
    all: mapped
  };
}

export async function ensureLiepinTargetPage({
  port = DEFAULT_DEBUG_PORT,
  targetPage = "recommend",
  timeoutMs = 15000
} = {}) {
  const resolvedPort = parsePositiveInteger(port, DEFAULT_DEBUG_PORT);
  const normalizedTarget = normalizeLiepinTargetPage(targetPage);
  const url = getLiepinTargetUrl(normalizedTarget);
  const before = await discoverLiepinPages({ port: resolvedPort });
  if (before[normalizedTarget]) {
    return {
      ok: true,
      changed: false,
      targetPage: normalizedTarget,
      url,
      page: before[normalizedTarget],
      reason: "already_open"
    };
  }
  if (before.riskPage && !hasAnyWorkflowPage(before)) {
    return {
      ok: false,
      changed: false,
      targetPage: normalizedTarget,
      url,
      blocked: true,
      reason: "risk_page",
      page: before.riskPage
    };
  }

  const navigation = await navigateExistingOrOpenNewTarget({
    port: resolvedPort,
    pages: before,
    url
  });
  const page = await waitForLiepinPageKind({
    port: resolvedPort,
    kind: normalizedTarget,
    timeoutMs
  });
  return {
    ok: Boolean(page),
    changed: true,
    targetPage: normalizedTarget,
    url,
    page,
    navigation,
    reason: page ? "navigated" : "target_not_found_after_navigation"
  };
}

export async function launchChromeDebug({
  port = DEFAULT_DEBUG_PORT,
  url = LIEPIN_URLS.recommend,
  userDataDir = null,
  chromePath = null,
  waitTimeoutMs = 15000,
  extraArgs = []
} = {}) {
  const resolvedPort = parsePositiveInteger(port, DEFAULT_DEBUG_PORT);
  const executablePath = chromePath || findChromeExecutable();
  if (!executablePath) {
    return {
      ok: false,
      port: resolvedPort,
      error: {
        code: "CHROME_EXECUTABLE_NOT_FOUND",
        message: "未找到 Chrome 可执行文件，无法自动打开 debug Chrome。"
      }
    };
  }
  const resolvedUserDataDir = userDataDir || path.join(os.homedir(), ".liepin-recommend-mcp", `chrome-debug-profile-${resolvedPort}`);
  const args = buildChromeDebugLaunchArgs({
    port: resolvedPort,
    userDataDir: resolvedUserDataDir,
    url,
    extraArgs
  });
  try {
    fs.mkdirSync(resolvedUserDataDir, { recursive: true });
    const child = spawn(executablePath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    const connection = await waitForChromeConnection({
      port: resolvedPort,
      timeoutMs: waitTimeoutMs
    });
    return {
      ok: connection.ok,
      port: resolvedPort,
      pid: child.pid,
      executablePath,
      userDataDir: resolvedUserDataDir,
      launchArgs: args,
      error: connection.ok ? null : connection.error
    };
  } catch (error) {
    return {
      ok: false,
      port: resolvedPort,
      executablePath,
      userDataDir: resolvedUserDataDir,
      launchArgs: args,
      error: {
        code: "CHROME_LAUNCH_FAILED",
        message: error?.message || String(error)
      }
    };
  }
}

export function buildChromeDebugLaunchArgs({
  port = DEFAULT_DEBUG_PORT,
  userDataDir,
  url = LIEPIN_URLS.recommend,
  extraArgs = []
} = {}) {
  const resolvedPort = parsePositiveInteger(port, DEFAULT_DEBUG_PORT);
  const args = [
    `--remote-debugging-port=${resolvedPort}`,
    userDataDir ? `--user-data-dir=${userDataDir}` : null,
    "--no-first-run",
    "--no-default-browser-check",
    ...REQUIRED_CHROME_DEBUG_FLAGS,
    ...parseChromeExtraArgs(process.env.LIEPIN_EXTRA_CHROME_ARGS),
    ...extraArgs
  ];
  if (normalizeText(url)) args.push(url);
  return normalizeChromeLaunchArgs(args);
}

function parseChromeExtraArgs(value = "") {
  return String(value || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseChromeCommandLineArgs(commandLineOrArgs = []) {
  if (Array.isArray(commandLineOrArgs)) {
    return commandLineOrArgs
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  const text = String(commandLineOrArgs || "").trim();
  if (!text) return [];
  const args = [];
  let current = "";
  let quote = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function splitChromeFeatureList(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function chromeFlagIsPresent(args, requiredFlag) {
  if (!requiredFlag) return true;
  const disableFeaturesPrefix = "--disable-features=";
  if (requiredFlag.startsWith(disableFeaturesPrefix)) {
    const requiredFeatures = splitChromeFeatureList(requiredFlag.slice(disableFeaturesPrefix.length));
    const disableFeatureArgs = args.filter((arg) => arg.startsWith(disableFeaturesPrefix));
    const lastDisableFeatureArg = disableFeatureArgs[disableFeatureArgs.length - 1] || "";
    const features = splitChromeFeatureList(lastDisableFeatureArg.slice(disableFeaturesPrefix.length));
    return requiredFeatures.every((feature) => features.includes(feature));
  }
  return args.includes(requiredFlag);
}

export function getMissingRequiredChromeFlags(
  commandLineOrArgs = [],
  requiredFlags = REQUIRED_CHROME_DEBUG_FLAGS
) {
  const args = parseChromeCommandLineArgs(commandLineOrArgs);
  return requiredFlags.filter((flag) => !chromeFlagIsPresent(args, flag));
}

function normalizeChromeLaunchArgs(args = []) {
  const disableFeaturesPrefix = "--disable-features=";
  const result = [];
  const seen = new Set();
  const disabledFeatures = [];
  const disabledFeatureSet = new Set();
  let disabledFeatureIndex = -1;

  for (const rawArg of args) {
    const arg = String(rawArg || "").trim();
    if (!arg) continue;
    if (arg.startsWith(disableFeaturesPrefix)) {
      if (disabledFeatureIndex < 0) {
        disabledFeatureIndex = result.length;
        result.push(null);
      }
      for (const feature of splitChromeFeatureList(arg.slice(disableFeaturesPrefix.length))) {
        if (!disabledFeatureSet.has(feature)) {
          disabledFeatureSet.add(feature);
          disabledFeatures.push(feature);
        }
      }
      continue;
    }
    if (seen.has(arg)) continue;
    seen.add(arg);
    result.push(arg);
  }

  return result.map((arg) => (
    arg === null
      ? `${disableFeaturesPrefix}${disabledFeatures.join(",")}`
      : arg
  ));
}

export async function ensureChromeDebugPort({
  port = DEFAULT_DEBUG_PORT,
  url = LIEPIN_URLS.recommend,
  userDataDir = null,
  launchIfMissing = true,
  autoReplace = true,
  waitTimeoutMs = 15000,
  _deps = {}
} = {}) {
  const resolvedPort = parsePositiveInteger(port, DEFAULT_DEBUG_PORT);
  const connectToChromeImpl = _deps.connectToChromeImpl || connectToChrome;
  const inspectCommandLineImpl = _deps.inspectChromeDebugCommandLineImpl || inspectChromeDebugCommandLine;
  const closeChromeDebugInstanceImpl = _deps.closeChromeDebugInstanceImpl || closeChromeDebugInstance;
  const launchChromeDebugImpl = _deps.launchChromeDebugImpl || launchChromeDebug;
  const base = {
    ok: false,
    port: resolvedPort,
    guardChecked: true,
    requiredFlags: REQUIRED_CHROME_DEBUG_FLAGS,
    missingFlags: [],
    requiredFlagsOk: false,
    reused: false,
    launched: false,
    replaced: false,
    closeMethod: null,
    relaunch: null
  };

  const connection = await connectToChromeImpl({ port: resolvedPort });
  if (!connection.ok) {
    if (!launchIfMissing) {
      return {
        ...base,
        reason: "chrome_unreachable",
        error: connection.error
      };
    }
    const launch = await launchChromeDebugImpl({
      port: resolvedPort,
      url,
      userDataDir,
      waitTimeoutMs
    });
    return {
      ...base,
      ok: Boolean(launch.ok),
      requiredFlagsOk: Boolean(launch.ok),
      launched: Boolean(launch.ok),
      reason: "chrome_unreachable",
      relaunch: summarizeChromeLaunch(launch, "chrome_unreachable"),
      launch
    };
  }

  const commandLine = await inspectCommandLineImpl({ port: resolvedPort, _deps });
  const missingFlags = commandLine?.ok
    ? getMissingRequiredChromeFlags(commandLine.arguments)
    : REQUIRED_CHROME_DEBUG_FLAGS.slice();
  const evidence = {
    commandLineSource: commandLine?.source || "unknown",
    commandLineError: commandLine?.ok ? null : commandLine?.error || "Chrome command line could not be inspected",
    commandLineArgsCount: Array.isArray(commandLine?.arguments) ? commandLine.arguments.length : 0,
    inspectedProcess: commandLine?.process || null,
    inspectedProcesses: commandLine?.processes || []
  };
  if (missingFlags.length === 0) {
    return {
      ...base,
      ...evidence,
      ok: true,
      requiredFlagsOk: true,
      reused: true
    };
  }
  if (!autoReplace) {
    return {
      ...base,
      ...evidence,
      ok: false,
      reason: commandLine?.ok ? "missing_required_flags" : "unknown_required_flags",
      missingFlags
    };
  }

  const closeResult = await closeChromeDebugInstanceImpl({
    port: resolvedPort,
    processes: commandLine?.processes || [],
    _deps
  });
  if (!closeResult?.ok) {
    return {
      ...base,
      ...evidence,
      reason: "replace_close_failed",
      missingFlags,
      closeMethod: closeResult?.method || null,
      closeResult,
      error: {
        code: "CHROME_REQUIRED_FLAGS_REPLACE_FAILED",
        message: closeResult?.error || "Failed to close Chrome debug instance"
      }
    };
  }
  const launch = await launchChromeDebugImpl({
    port: resolvedPort,
    url,
    userDataDir,
    waitTimeoutMs
  });
  return {
    ...base,
    ...evidence,
    ok: Boolean(launch.ok),
    requiredFlagsOk: Boolean(launch.ok),
    reason: "missing_required_flags",
    missingFlags,
    replaced: Boolean(launch.ok),
    closeMethod: closeResult.method || null,
    closeResult,
    relaunch: summarizeChromeLaunch(launch, "missing_required_flags"),
    launch,
    error: launch.ok ? null : launch.error
  };
}

export async function inspectChromeDebugCommandLine({
  port = DEFAULT_DEBUG_PORT,
  _deps = {}
} = {}) {
  const inspectViaCdp = _deps.inspectChromeCommandLineViaCdpImpl || inspectChromeCommandLineViaCdp;
  const inspectViaProcess = _deps.inspectChromeCommandLineViaProcessListImpl || inspectChromeCommandLineViaProcessList;
  const cdpResult = await inspectViaCdp({ port });
  if (cdpResult?.ok && cdpResult.arguments?.length) return cdpResult;
  const processResult = await inspectViaProcess({ port });
  if (processResult?.ok && processResult.arguments?.length) {
    return {
      ...processResult,
      cdpError: cdpResult?.error || null
    };
  }
  return {
    ok: false,
    source: processResult?.source || cdpResult?.source || "unknown",
    arguments: [],
    processes: processResult?.processes || [],
    error: processResult?.error || cdpResult?.error || "Chrome command line could not be inspected"
  };
}

async function inspectChromeCommandLineViaCdp({ port = DEFAULT_DEBUG_PORT } = {}) {
  const resolvedPort = parsePositiveInteger(port, DEFAULT_DEBUG_PORT);
  const connection = await connectToChrome({ port: resolvedPort });
  const wsUrl = connection.version?.webSocketDebuggerUrl;
  if (!connection.ok || !wsUrl) {
    return {
      ok: false,
      source: "cdp_browser_command_line",
      arguments: [],
      error: connection.error?.message || "Browser websocket URL is unavailable"
    };
  }
  const client = new CdpPageClient(wsUrl);
  try {
    await client.connect();
    const result = await client.send("Browser.getBrowserCommandLine", {}, { timeoutMs: 3000 });
    const args = parseChromeCommandLineArgs(result?.arguments || []);
    return args.length > 0
      ? { ok: true, source: "cdp_browser_command_line", arguments: args }
      : {
          ok: false,
          source: "cdp_browser_command_line",
          arguments: [],
          error: "Browser.getBrowserCommandLine returned no command-line arguments"
        };
  } catch (error) {
    return {
      ok: false,
      source: "cdp_browser_command_line",
      arguments: [],
      error: error?.message || String(error)
    };
  } finally {
    await client.disconnect().catch(() => null);
  }
}

async function inspectChromeCommandLineViaProcessList({ port = DEFAULT_DEBUG_PORT } = {}) {
  const resolvedPort = parsePositiveInteger(port, DEFAULT_DEBUG_PORT);
  if (process.platform === "win32") {
    const portPattern = `--remote-debugging-port(=|\\s+)${resolvedPort}(\\s|$)`;
    const script = [
      "$items = Get-CimInstance Win32_Process",
      `| Where-Object { $_.CommandLine -and $_.CommandLine -match '${portPattern}' }`,
      "| Select-Object ProcessId,CommandLine;",
      "$items | ConvertTo-Json -Compress"
    ].join(" ");
    const raw = await execFileText("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ], { timeoutMs: 6000 });
    if (!raw.ok) {
      return {
        ok: false,
        source: "process_list",
        arguments: [],
        processes: [],
        error: raw.error || raw.stderr || "Failed to inspect Windows process list"
      };
    }
    try {
      const processes = parseWindowsProcessListJson(raw.stdout);
      return commandLineResultFromProcesses(processes, resolvedPort);
    } catch (error) {
      return {
        ok: false,
        source: "process_list",
        arguments: [],
        processes: [],
        error: `Failed to parse Windows process list: ${error?.message || error}`
      };
    }
  }

  const psArgs = process.platform === "darwin"
    ? ["-axo", "pid=,command="]
    : ["-eo", "pid=,args="];
  const raw = await execFileText("ps", psArgs, { timeoutMs: 6000 });
  if (!raw.ok) {
    return {
      ok: false,
      source: "process_list",
      arguments: [],
      processes: [],
      error: raw.error || raw.stderr || "Failed to inspect process list"
    };
  }
  return commandLineResultFromProcesses(parsePosixProcessList(raw.stdout, resolvedPort), resolvedPort);
}

function commandLineResultFromProcesses(processes = [], port = DEFAULT_DEBUG_PORT) {
  if (processes.length === 0) {
    return {
      ok: false,
      source: "process_list",
      arguments: [],
      processes: [],
      error: `No local process was found for --remote-debugging-port=${port}`
    };
  }
  const primary = processes[0];
  return {
    ok: true,
    source: "process_list",
    arguments: parseChromeCommandLineArgs(primary.command_line),
    process: {
      pid: primary.pid,
      command_line_length: primary.command_line.length
    },
    processes: summarizeChromeProcesses(processes)
  };
}

function parseWindowsProcessListJson(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items
    .map((item) => ({
      pid: Number(item?.ProcessId),
      command_line: String(item?.CommandLine || "")
    }))
    .filter((item) => Number.isFinite(item.pid) && item.command_line);
}

function parsePosixProcessList(text = "", port = DEFAULT_DEBUG_PORT) {
  const portPattern = new RegExp(`--remote-debugging-port(?:=|\\s+)${port}(?=\\s|$)`);
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      return match
        ? { pid: Number(match[1]), command_line: match[2] }
        : null;
    })
    .filter((item) => item && Number.isFinite(item.pid) && portPattern.test(item.command_line));
}

function summarizeChromeProcesses(processes = []) {
  return processes
    .map((item) => ({
      pid: item.pid,
      command_line_length: String(item.command_line || "").length
    }))
    .filter((item) => Number.isFinite(item.pid));
}

export async function closeChromeDebugInstance({
  port = DEFAULT_DEBUG_PORT,
  processes = [],
  timeoutMs = 8000,
  pollMs = 300,
  _deps = {}
} = {}) {
  const resolvedPort = parsePositiveInteger(port, DEFAULT_DEBUG_PORT);
  const waitClosed = _deps.waitForChromeDebugPortClosedImpl || waitForChromeDebugPortClosed;
  let browserCloseAttempted = false;
  let browserCloseError = null;
  try {
    const connection = await connectToChrome({ port: resolvedPort });
    const wsUrl = connection.version?.webSocketDebuggerUrl;
    if (!connection.ok || !wsUrl) {
      throw new Error(connection.error?.message || "Browser websocket URL is unavailable");
    }
    const client = new CdpPageClient(wsUrl);
    try {
      await client.connect();
      browserCloseAttempted = true;
      await client.send("Browser.close", {}, { timeoutMs: 3000 });
    } finally {
      await client.disconnect().catch(() => null);
    }
  } catch (error) {
    browserCloseError = error?.message || String(error);
  }

  let closed = await waitClosed({ port: resolvedPort, timeoutMs, pollMs });
  if (closed.ok) {
    return {
      ok: true,
      method: browserCloseAttempted ? "Browser.close" : "port_already_closed",
      elapsed_ms: closed.elapsed_ms,
      browserCloseError
    };
  }

  const pids = Array.from(new Set((processes || [])
    .map((item) => Number(item?.pid))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid)));
  const killedPids = [];
  const processErrors = [];
  for (const pid of pids) {
    try {
      process.kill(pid);
      killedPids.push(pid);
    } catch (error) {
      processErrors.push({
        pid,
        error: error?.message || String(error)
      });
    }
  }
  if (killedPids.length > 0) {
    closed = await waitClosed({ port: resolvedPort, timeoutMs, pollMs });
    if (closed.ok) {
      return {
        ok: true,
        method: browserCloseAttempted ? "Browser.close+process.kill" : "process.kill",
        elapsed_ms: closed.elapsed_ms,
        killedPids,
        browserCloseError,
        processErrors
      };
    }
  }
  return {
    ok: false,
    method: browserCloseAttempted && killedPids.length > 0
      ? "Browser.close+process.kill"
      : browserCloseAttempted
        ? "Browser.close"
        : killedPids.length > 0
          ? "process.kill"
          : "none",
    killedPids,
    browserCloseError,
    processErrors,
    wait: closed,
    error: closed.error || browserCloseError || "Failed to close Chrome debug instance"
  };
}

async function waitForChromeDebugPortClosed({
  port = DEFAULT_DEBUG_PORT,
  timeoutMs = 6000,
  pollMs = 300
} = {}) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const connection = await connectToChrome({ port });
    if (!connection.ok) {
      return {
        ok: true,
        elapsed_ms: Date.now() - started
      };
    }
    await sleep(pollMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    error: `Chrome debug port ${port} is still reachable`
  };
}

function summarizeChromeLaunch(launch = {}, reason = "") {
  return {
    reason,
    ok: Boolean(launch?.ok),
    launched: Boolean(launch?.ok),
    executablePath: launch?.executablePath || null,
    userDataDir: launch?.userDataDir || null,
    launchArgs: Array.isArray(launch?.launchArgs) ? launch.launchArgs : [],
    error: launch?.error || null
  };
}

function execFileText(file, args = [], { timeoutMs = 5000, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: error?.message || ""
      });
    });
  });
}

export async function waitForChromeConnection({
  port = DEFAULT_DEBUG_PORT,
  timeoutMs = 15000,
  pollMs = 300
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await connectToChrome({ port });
    if (last.ok) return last;
    await sleep(pollMs);
  }
  return last || await connectToChrome({ port });
}

export function findChromeExecutable({
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync
} = {}) {
  const candidates = [];
  const pathApi = platform === "win32" ? path.win32 : path;
  if (env.CHROME_PATH) candidates.push(env.CHROME_PATH);
  if (env.GOOGLE_CHROME_BIN) candidates.push(env.GOOGLE_CHROME_BIN);
  if (platform === "win32") {
    const programFiles = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    for (const base of programFiles) {
      candidates.push(pathApi.join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
    candidates.push("chrome.exe");
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      pathApi.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "google-chrome",
      "chrome"
    );
  } else {
    candidates.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser");
  }
  return candidates.find((candidate) => {
    if (!candidate) return false;
    if (!pathApi.isAbsolute(candidate)) return true;
    try {
      return exists(candidate);
    } catch {
      return false;
    }
  }) || null;
}

export async function waitForTarget({ port = DEFAULT_DEBUG_PORT, knownTargetIds = [], match, timeoutMs = 8000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const known = new Set(knownTargetIds);
  while (Date.now() < deadline) {
    const targets = await listTargets({ port });
    const matched = targets.find((target) => {
      if (known.has(target.id)) return false;
      return typeof match === "function" ? match(target) : false;
    });
    if (matched) return matched;
    await sleep(pollMs);
  }
  return null;
}

async function navigateExistingOrOpenNewTarget({ port, pages, url }) {
  const source = pages.recommend || pages.search || pages.chat || pages.resumeDetail || pages.all?.find((item) => item.kind === "other");
  if (source?.webSocketDebuggerUrl) {
    const client = await createPageClient(source);
    try {
      await client.send("Page.enable").catch(() => null);
      await client.send("Page.navigate", { url });
      return {
        mode: "navigate_existing",
        sourceTargetId: source.id,
        url
      };
    } catch (error) {
      return openNewTarget({ port, url, fallbackError: error });
    } finally {
      await client.disconnect().catch(() => null);
    }
  }
  return openNewTarget({ port, url });
}

async function openNewTarget({ port, url, fallbackError = null }) {
  const browserURL = `http://127.0.0.1:${parsePositiveInteger(port, DEFAULT_DEBUG_PORT)}`;
  const endpoint = `${browserURL}/json/new?${encodeURIComponent(url)}`;
  try {
    const target = await putJson(endpoint);
    return {
      mode: "open_new",
      targetId: target?.id || null,
      url
    };
  } catch (error) {
    return {
      mode: "open_new_failed",
      url,
      error: error?.message || String(error),
      fallbackError: fallbackError?.message || null
    };
  }
}

async function waitForLiepinPageKind({ port, kind, timeoutMs = 15000, pollMs = 300 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = await discoverLiepinPages({ port });
    if (pages[kind]) return pages[kind];
    await sleep(pollMs);
  }
  return null;
}

function hasAnyWorkflowPage(pages = {}) {
  return Boolean(pages.recommend || pages.search || pages.chat || pages.resumeDetail);
}

function normalizeLiepinTargetPage(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === "chat") return "chat";
  if (normalized === "search") return "search";
  return "recommend";
}

export async function createPageClient(targetOrWsUrl) {
  const wsUrl = typeof targetOrWsUrl === "string"
    ? targetOrWsUrl
    : targetOrWsUrl?.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new Error("Missing page websocket debugger URL");
  }
  const client = new CdpPageClient(wsUrl);
  await client.connect();
  return client;
}

export class CdpPageClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = (error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const cleanup = () => {
        this.socket.removeEventListener("open", handleOpen);
        this.socket.removeEventListener("error", handleError);
      };
      this.socket.addEventListener("open", handleOpen);
      this.socket.addEventListener("error", handleError);
    });

    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(message.error.message || "CDP call failed"));
          return;
        }
        resolve(message.result);
        return;
      }
      if (!message.method) return;
      const handlers = this.listeners.get(message.method) || [];
      for (const handler of handlers) {
        try {
          handler(message.params || {});
        } catch {}
      }
    });

  }

  async send(method, params = {}, { timeoutMs = DEFAULT_CDP_CALL_TIMEOUT_MS } = {}) {
    if (!this.socket) throw new Error("CDP socket is not connected");
    const resolvedTimeoutMs = parsePositiveInteger(timeoutMs, DEFAULT_CDP_CALL_TIMEOUT_MS);
    const id = this.nextId += 1;
    const payload = JSON.stringify({
      id,
      method,
      params
    });
    const result = await new Promise((resolve, reject) => {
      let timeout = null;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
      };
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        }
      });
      this.socket.send(payload);
      timeout = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, resolvedTimeoutMs);
    });
    return result;
  }

  async evaluate(expressionOrFunction, ...args) {
    return this.evaluateWithTimeout(expressionOrFunction, args);
  }

  async evaluateWithTimeout(expressionOrFunction, args = [], { timeoutMs = DEFAULT_CDP_CALL_TIMEOUT_MS } = {}) {
    const expression = typeof expressionOrFunction === "function"
      ? `(${expressionOrFunction})(${args.map((value) => JSON.stringify(value)).join(",")})`
      : String(expressionOrFunction);
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }, {
      timeoutMs
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
  }

  async waitFor(predicateFn, args = [], { timeoutMs = 10000, pollMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remainingMs = Math.max(1, deadline - Date.now());
      let result = null;
      try {
        result = await this.evaluateWithTimeout(predicateFn, args, {
          timeoutMs: Math.min(
            DEFAULT_CDP_CALL_TIMEOUT_MS,
            Math.max(MIN_CDP_WAIT_EVALUATE_TIMEOUT_MS, remainingMs)
          )
        });
      } catch (error) {
        if (isCdpRuntimeTimeoutError(error) && Date.now() >= deadline) {
          return null;
        }
        throw error;
      }
      if (result) return result;
      const sleepMs = Math.min(pollMs, Math.max(0, deadline - Date.now()));
      if (sleepMs > 0) await sleep(sleepMs);
    }
    return null;
  }

  async bringToFront() {
    // Keep browser automation background-safe: do not surface Chrome windows/tabs.
    return false;
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) || [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
    return () => this.off(method, handler);
  }

  off(method, handler) {
    const handlers = this.listeners.get(method) || [];
    const nextHandlers = handlers.filter((candidate) => candidate !== handler);
    if (nextHandlers.length === 0) {
      this.listeners.delete(method);
      return;
    }
    this.listeners.set(method, nextHandlers);
  }

  async closePage() {
    try {
      await this.send("Page.close");
    } catch {}
  }

  async disconnect() {
    if (!this.socket) return;
    this.listeners.clear();
    this.socket.close();
    this.socket = null;
  }
}

export function isCdpRuntimeTimeoutError(error) {
  return /CDP timeout: Runtime\.evaluate/.test(error?.message || "");
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function putJson(url) {
  const response = await fetch(url, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}
