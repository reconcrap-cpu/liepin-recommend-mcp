import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_DEBUG_PORT, LIEPIN_URLS } from "./constants.js";
import { normalizeText, parsePositiveInteger, sleep } from "./utils.js";

export const DEFAULT_CDP_CALL_TIMEOUT_MS = 30000;

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
  waitTimeoutMs = 15000
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
  const args = [
    `--remote-debugging-port=${resolvedPort}`,
    `--user-data-dir=${resolvedUserDataDir}`,
    "--no-first-run",
    "--no-default-browser-check"
  ];
  if (normalizeText(url)) args.push(url);
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
      error: connection.ok ? null : connection.error
    };
  } catch (error) {
    return {
      ok: false,
      port: resolvedPort,
      executablePath,
      userDataDir: resolvedUserDataDir,
      error: {
        code: "CHROME_LAUNCH_FAILED",
        message: error?.message || String(error)
      }
    };
  }
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
      const result = await this.evaluateWithTimeout(predicateFn, args, {
        timeoutMs: Math.min(DEFAULT_CDP_CALL_TIMEOUT_MS, remainingMs)
      });
      if (result) return result;
      await sleep(pollMs);
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
