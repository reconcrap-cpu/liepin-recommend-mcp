import test from "node:test";
import assert from "node:assert/strict";

import {
  isAlreadyContactedButtonText,
  isImmediateChatButtonText
} from "./search-action.js";

test("search chat button text helpers distinguish immediate and already-contacted states", () => {
  assert.equal(isImmediateChatButtonText(" 立即沟通 "), true);
  assert.equal(isImmediateChatButtonText("继续沟通"), false);
  assert.equal(isAlreadyContactedButtonText("继续沟通"), true);
  assert.equal(isAlreadyContactedButtonText("立即沟通"), false);
});
