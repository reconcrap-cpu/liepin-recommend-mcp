import test from "node:test";
import assert from "node:assert/strict";

import {
  CdpPageClient,
  classifyLiepinPage,
  findChromeExecutable,
  getLiepinTargetUrl,
  isCdpRuntimeTimeoutError,
  isLiepinRiskPageUrl,
  MIN_CDP_WAIT_EVALUATE_TIMEOUT_MS
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
