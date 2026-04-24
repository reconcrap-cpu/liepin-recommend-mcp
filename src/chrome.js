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
