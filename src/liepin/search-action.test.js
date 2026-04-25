import test from "node:test";
import assert from "node:assert/strict";

import {
  isAlreadyContactedButtonText,
  isImmediateChatButtonText
} from "./search-action.js";
import { searchSelectors } from "./selectors.js";

test("search chat button text helpers distinguish immediate and already-contacted states", () => {
  assert.equal(isImmediateChatButtonText(" 立即沟通 "), true);
  assert.equal(isImmediateChatButtonText("继续沟通"), false);
  assert.equal(isAlreadyContactedButtonText("继续沟通"), true);
  assert.equal(isAlreadyContactedButtonText("立即沟通"), false);
});

test("service job row selector supports the current modal div structure", () => {
  assert.equal(searchSelectors.serviceJobContainer, '[id^="serviceJobListContainer"]');
  assert.equal(searchSelectors.serviceJobRow.includes('> div > div > div'), true);
  assert.equal(searchSelectors.serviceJobRow.includes('[class*="jobListWrap"] li'), true);
});
