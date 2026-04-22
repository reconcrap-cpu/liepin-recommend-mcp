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
