import test from "node:test";
import assert from "node:assert/strict";

import {
  chatJobTitleMatches,
  dispatchMouseClick,
  ensureChatUnreadFilter,
  normalizeChatJobOptions
} from "./chat-options.js";

test("normalizeChatJobOptions returns unique selectable chat jobs", () => {
  const jobs = normalizeChatJobOptions([
    { title: "全部职位", description: "", selected: true },
    { title: "招聘实习生", description: "杭州 · 实习", selected: false },
    { title: "招聘实习生", description: "杭州 · 实习", selected: false },
    { title: "", description: "ignored" }
  ]);

  assert.deepEqual(jobs.map((job) => job.title), ["全部职位", "招聘实习生"]);
  assert.equal(jobs[0].selected, true);
  assert.equal(jobs[1].label, "招聘实习生 杭州 · 实习");
});

test("chatJobTitleMatches accepts selected job text with appended metadata", () => {
  assert.equal(chatJobTitleMatches("招聘实习生 杭州-拱墅区 · 实习", "招聘实习生"), true);
  assert.equal(chatJobTitleMatches("全部职位", "全部职位"), true);
  assert.equal(chatJobTitleMatches("产品经理", "招聘实习生"), false);
});

test("dispatchMouseClick uses background CDP mouse events without bringToFront", async () => {
  const calls = [];
  const client = {
    async send(method, params) {
      calls.push({ method, params });
    }
  };

  await dispatchMouseClick(client, { x: 12, y: 34 });

  assert.deepEqual(calls.map((call) => call.method), [
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent"
  ]);
  assert.equal(calls.some((call) => call.method === "Page.bringToFront"), false);
  assert.deepEqual(calls.map((call) => call.params.type), [
    "mouseMoved",
    "mousePressed",
    "mouseReleased"
  ]);
});

test("ensureChatUnreadFilter toggles checkbox only when target state differs", async () => {
  let checked = false;
  const calls = [];
  const client = {
    async evaluate(fn, arg) {
      const source = String(fn);
      if (arg?.selector) {
        return {
          x: 10,
          y: 10,
          text: "未读",
          className: checked ? "ant-im-checkbox ant-im-checkbox-checked" : "ant-im-checkbox"
        };
      }
      if (source.includes("checkedByInput") && source.includes("checkedByClass")) {
        return {
          found: true,
          checked,
          checkedByInput: checked,
          checkedByClass: checked,
          className: checked ? "ant-im-checkbox ant-im-checkbox-checked" : "ant-im-checkbox",
          labelText: "未读"
        };
      }
      throw new Error(`Unexpected evaluate call: ${source.slice(0, 80)}`);
    },
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
        checked = true;
      }
    }
  };

  const result = await ensureChatUnreadFilter(client, true);

  assert.equal(result.ok, true);
  assert.equal(result.before.checked, false);
  assert.equal(result.after.checked, true);
  assert.equal(calls.some((call) => call.method === "Page.bringToFront"), false);
});
