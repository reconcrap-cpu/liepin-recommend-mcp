import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPageRuntimeResponsive,
  isPageRuntimeUnresponsiveError,
  PAGE_RUNTIME_UNRESPONSIVE_CODE
} from "./page-health.js";

test("assertPageRuntimeResponsive returns page snapshot when Runtime responds", async () => {
  const client = {
    async evaluateWithTimeout(expressionOrFunction, args, options) {
      assert.equal(typeof expressionOrFunction, "function");
      assert.deepEqual(args, []);
      assert.equal(options.timeoutMs, 1234);
      return {
        href: "https://lpt.liepin.com/chat/im",
        title: "在线沟通",
        readyState: "complete"
      };
    }
  };

  const snapshot = await assertPageRuntimeResponsive(client, {
    pageName: "猎聘聊天页",
    timeoutMs: 1234
  });

  assert.equal(snapshot.href, "https://lpt.liepin.com/chat/im");
});

test("assertPageRuntimeResponsive wraps Runtime timeouts with an actionable code", async () => {
  const client = {
    async evaluateWithTimeout() {
      throw new Error("CDP timeout: Runtime.evaluate");
    }
  };

  await assert.rejects(
    () => assertPageRuntimeResponsive(client, { pageName: "猎聘聊天页", timeoutMs: 10 }),
    (error) => {
      assert.equal(error.code, PAGE_RUNTIME_UNRESPONSIVE_CODE);
      assert.equal(error.runtimeTimeout, true);
      assert.equal(isPageRuntimeUnresponsiveError(error), true);
      assert.match(error.message, /猎聘聊天页 Runtime 不响应/u);
      return true;
    }
  );
});
