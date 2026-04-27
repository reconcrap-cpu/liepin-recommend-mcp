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

test("buildDoctorRecommendations targets the requested page", () => {
  const recommendations = buildDoctorRecommendations({
    chrome: {
      ok: true,
      loginOk: true,
      pages: { chat: null }
    },
    port: 9223,
    targetPage: "chat",
    requireChatPage: true
  });

  const target = recommendations.find((item) => item.code === "OPEN_TARGET_PAGE");
  assert.equal(target?.severity, "warning");
  assert.equal(target?.url, "https://lpt.liepin.com/chat/im");
  assert.equal(target?.command.includes("--target-page chat"), true);
});

test("buildDoctorRecommendations asks for login only after automatic page fixes are exhausted", () => {
  const recommendations = buildDoctorRecommendations({
    chrome: {
      ok: true,
      loginOk: false,
      riskBlocked: false,
      pages: {}
    },
    port: 9223,
    targetPage: "search"
  });

  const login = recommendations.find((item) => item.code === "LOGIN_LIEPIN");
  assert.equal(login?.severity, "error");
  assert.equal(login?.url, "https://lpt.liepin.com/search");
});
