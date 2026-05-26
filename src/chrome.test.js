import test from "node:test";
import assert from "node:assert/strict";

import {
  CdpPageClient,
  buildChromeDebugLaunchArgs,
  classifyLiepinPage,
  ensureChromeDebugPort,
  findChromeExecutable,
  getLiepinTargetUrl,
  getMissingRequiredChromeFlags,
  isCdpRuntimeTimeoutError,
  isLiepinRiskPageUrl,
  MIN_CDP_WAIT_EVALUATE_TIMEOUT_MS,
  REQUIRED_CHROME_DEBUG_FLAGS
} from "./chrome.js";

test("classifyLiepinPage detects Liepin risk captcha before normal pages", () => {
  const riskUrl = "https://safe.liepin.com/page/liepin/captchaPage_PC?backurl=https://api-lpt.liepin.com/api/com.liepin.rresume.usere.pc.get-resume-bright-risk";
  assert.equal(isLiepinRiskPageUrl(riskUrl), true);
  assert.equal(classifyLiepinPage(riskUrl), "risk");
});

test("classifyLiepinPage classifies normal Liepin targets", () => {
  assert.equal(classifyLiepinPage("https://lpt.liepin.com/recommend#preview"), "recommend");
  assert.equal(classifyLiepinPage("https://lpt.liepin.com/search#preview"), "search");
  assert.equal(classifyLiepinPage("https://lpt.liepin.com/chat/im#preview"), "chat");
  assert.equal(classifyLiepinPage("https://lpt.liepin.com/resume/detail?resIdEncode=abc"), "resume_detail");
});

test("getLiepinTargetUrl resolves workflow target URLs", () => {
  assert.equal(getLiepinTargetUrl("recommend"), "https://lpt.liepin.com/recommend");
  assert.equal(getLiepinTargetUrl("search"), "https://lpt.liepin.com/search");
  assert.equal(getLiepinTargetUrl("chat"), "https://lpt.liepin.com/chat/im");
});

test("findChromeExecutable honors explicit Chrome env paths", () => {
  const executable = findChromeExecutable({
    platform: "win32",
    env: {
      CHROME_PATH: "C:\\Chrome\\chrome.exe",
      PROGRAMFILES: "C:\\Program Files"
    },
    exists: (candidate) => candidate === "C:\\Chrome\\chrome.exe"
  });

  assert.equal(executable, "C:\\Chrome\\chrome.exe");
});

test("buildChromeDebugLaunchArgs includes required flags once", () => {
  const args = buildChromeDebugLaunchArgs({
    port: 9555,
    userDataDir: "C:\\tmp\\liepin-profile-9555",
    url: "https://lpt.liepin.com/recommend",
    extraArgs: [
      ...REQUIRED_CHROME_DEBUG_FLAGS,
      "--disable-features=Foo"
    ]
  });

  for (const flag of REQUIRED_CHROME_DEBUG_FLAGS) {
    if (flag.startsWith("--disable-features=")) {
      const disableFeatureArgs = args.filter((arg) => arg.startsWith("--disable-features="));
      assert.equal(disableFeatureArgs.length, 1);
      assert.equal(disableFeatureArgs[0].includes("CalculateNativeWinOcclusion"), true);
      assert.equal(disableFeatureArgs[0].includes("Foo"), true);
    } else {
      assert.equal(args.filter((arg) => arg === flag).length, 1);
    }
  }
  assert.deepEqual(getMissingRequiredChromeFlags(args), []);
});

test("getMissingRequiredChromeFlags detects shadowed disable-features switches", () => {
  assert.deepEqual(
    getMissingRequiredChromeFlags([
      "--remote-debugging-port=9223",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion"
    ]),
    []
  );
  assert.deepEqual(
    getMissingRequiredChromeFlags([
      "--remote-debugging-port=9223",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
      "--disable-features=Foo"
    ]),
    ["--disable-features=CalculateNativeWinOcclusion"]
  );
});

test("ensureChromeDebugPort launches when port is unreachable", async () => {
  let launched = false;
  const result = await ensureChromeDebugPort({
    port: 9556,
    url: "https://lpt.liepin.com/search",
    userDataDir: "C:\\tmp\\liepin-profile-9556",
    _deps: {
      async connectToChromeImpl() {
        return {
          ok: false,
          error: { code: "CHROME_CONNECT_FAILED", message: "unreachable" }
        };
      },
      async launchChromeDebugImpl(params) {
        launched = true;
        return {
          ok: true,
          port: params.port,
          userDataDir: params.userDataDir,
          launchArgs: buildChromeDebugLaunchArgs(params)
        };
      }
    }
  });

  assert.equal(launched, true);
  assert.equal(result.ok, true);
  assert.equal(result.launched, true);
  assert.equal(result.requiredFlagsOk, true);
  assert.equal(result.relaunch.reason, "chrome_unreachable");
});

test("ensureChromeDebugPort reuses compliant Chrome", async () => {
  const result = await ensureChromeDebugPort({
    port: 9557,
    _deps: {
      async connectToChromeImpl() {
        return { ok: true, port: 9557 };
      },
      async inspectChromeDebugCommandLineImpl() {
        return {
          ok: true,
          source: "process_list",
          arguments: [
            "--remote-debugging-port=9557",
            ...REQUIRED_CHROME_DEBUG_FLAGS
          ],
          processes: [{ pid: 1234 }]
        };
      },
      async launchChromeDebugImpl() {
        throw new Error("should not launch");
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.replaced, false);
  assert.deepEqual(result.missingFlags, []);
});

test("ensureChromeDebugPort replaces noncompliant local Chrome", async () => {
  let closed = false;
  let launched = false;
  const result = await ensureChromeDebugPort({
    port: 9558,
    url: "https://lpt.liepin.com/chat/im",
    userDataDir: "C:\\tmp\\liepin-profile-9558",
    _deps: {
      async connectToChromeImpl() {
        return { ok: true, port: 9558 };
      },
      async inspectChromeDebugCommandLineImpl() {
        return {
          ok: true,
          source: "process_list",
          arguments: ["--remote-debugging-port=9558"],
          processes: [{ pid: 2222 }]
        };
      },
      async closeChromeDebugInstanceImpl(params) {
        closed = true;
        assert.deepEqual(params.processes, [{ pid: 2222 }]);
        return { ok: true, method: "Browser.close" };
      },
      async launchChromeDebugImpl(params) {
        launched = true;
        return {
          ok: true,
          port: params.port,
          userDataDir: params.userDataDir,
          launchArgs: buildChromeDebugLaunchArgs(params)
        };
      }
    }
  });

  assert.equal(closed, true);
  assert.equal(launched, true);
  assert.equal(result.ok, true);
  assert.equal(result.replaced, true);
  assert.equal(result.closeMethod, "Browser.close");
  assert.deepEqual(result.missingFlags, REQUIRED_CHROME_DEBUG_FLAGS);
});

test("ensureChromeDebugPort replaces unknown local Chrome flags", async () => {
  let closed = false;
  const result = await ensureChromeDebugPort({
    port: 9559,
    _deps: {
      async connectToChromeImpl() {
        return { ok: true, port: 9559 };
      },
      async inspectChromeDebugCommandLineImpl() {
        return {
          ok: false,
          source: "process_list",
          arguments: [],
          processes: [],
          error: "cannot prove flags"
        };
      },
      async closeChromeDebugInstanceImpl() {
        closed = true;
        return { ok: true, method: "Browser.close" };
      },
      async launchChromeDebugImpl(params) {
        return {
          ok: true,
          port: params.port,
          launchArgs: buildChromeDebugLaunchArgs(params)
        };
      }
    }
  });

  assert.equal(closed, true);
  assert.equal(result.ok, true);
  assert.equal(result.replaced, true);
  assert.equal(result.commandLineError, "cannot prove flags");
});

test("bringToFront is suppressed to keep Chrome in the background", async () => {
  const client = new CdpPageClient("ws://example.test/devtools/page/test");
  let sendCalled = false;
  client.send = async () => {
    sendCalled = true;
    throw new Error("send should not be called");
  };

  const result = await client.bringToFront();

  assert.equal(result, false);
  assert.equal(sendCalled, false);
});

test("send respects a custom CDP timeout", async () => {
  const client = new CdpPageClient("ws://example.test/devtools/page/test");
  client.socket = {
    send() {}
  };

  await assert.rejects(
    () => client.send("Runtime.evaluate", {}, { timeoutMs: 5 }),
    (error) => {
      assert.match(error.message, /CDP timeout: Runtime\.evaluate/);
      assert.equal(isCdpRuntimeTimeoutError(error), true);
      return true;
    }
  );
  assert.equal(client.pending.size, 0);
});

test("evaluateWithTimeout forwards timeout to Runtime.evaluate", async () => {
  const client = new CdpPageClient("ws://example.test/devtools/page/test");
  let observed = null;
  client.send = async (method, params, options) => {
    observed = { method, params, options };
    return {
      result: {
        value: "ok"
      }
    };
  };

  const result = await client.evaluateWithTimeout(() => "ok", [], {
    timeoutMs: 1234
  });

  assert.equal(result, "ok");
  assert.equal(observed.method, "Runtime.evaluate");
  assert.equal(observed.options.timeoutMs, 1234);
});

test("waitFor avoids near-zero Runtime.evaluate timeouts at the deadline", async () => {
  const client = new CdpPageClient("ws://example.test/devtools/page/test");
  const observedTimeouts = [];
  client.evaluateWithTimeout = async (_predicateFn, _args, options) => {
    observedTimeouts.push(options.timeoutMs);
    return false;
  };

  const result = await client.waitFor(() => false, [], {
    timeoutMs: 5,
    pollMs: 1
  });

  assert.equal(result, null);
  assert.ok(observedTimeouts.length >= 1);
  assert.ok(observedTimeouts.every((value) => value >= MIN_CDP_WAIT_EVALUATE_TIMEOUT_MS));
});
