import test from "node:test";
import assert from "node:assert/strict";

import { buildDoctorRecommendations } from "./doctor.js";

test("buildDoctorRecommendations suggests config template and Chrome launch fixes", () => {
  const recommendations = buildDoctorRecommendations({
    checks: [
      { key: "npm_dep_puppeteer_core", ok: true },
      { key: "screening_config", ok: false },
      { key: "chrome_9222", ok: false }
    ],
    screenConfig: {
      ok: false,
      exists: false,
      configPath: "C:/tmp/screening-config.json"
    },
    chrome: {
      ok: false
    },
    port: 9222
  });

  assert.equal(recommendations.some((item) => item.code === "CREATE_SCREENING_CONFIG"), true);
  assert.equal(recommendations.some((item) => item.code === "START_CHROME_DEBUG"), true);
});

test("buildDoctorRecommendations escalates missing chat page only when required", () => {
  const optional = buildDoctorRecommendations({
    chrome: {
      ok: true,
      pages: { chat: null }
    },
    port: 9223
  });
  const required = buildDoctorRecommendations({
    chrome: {
      ok: true,
      pages: { chat: null }
    },
    port: 9223,
    requireChatPage: true
  });

  assert.equal(optional.find((item) => item.code === "OPEN_CHAT_PAGE_IF_NEEDED")?.severity, "info");
  assert.equal(required.find((item) => item.code === "OPEN_CHAT_PAGE_IF_NEEDED")?.severity, "error");
});
