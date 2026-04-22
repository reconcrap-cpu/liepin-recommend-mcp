import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";

import { ENV_HOME } from "../constants.js";
import { runCvStructureSurvey } from "./cv-survey.js";

test("runCvStructureSurvey keeps sampling across rounds until minimum and stable batch are reached", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liepin-cv-survey-"));
  const recommendRounds = [
    [buildSample("a", "sig-1"), buildSample("b", "sig-2")],
    [buildSample("e", "sig-2"), buildSample("f", "sig-2")]
  ];
  const latestRounds = [
    [buildSample("c", "sig-2"), buildSample("d", "sig-2")],
    []
  ];
  let recommendIndex = 0;
  let latestIndex = 0;
  const previousHome = process.env[ENV_HOME];
  process.env[ENV_HOME] = path.join(workspaceRoot, ".liepin-home");

  try {
    const result = await runCvStructureSurvey({
      workspaceRoot,
      minimumSamples: 5,
      batchSize: 2,
      perPassLimit: 2,
      maxRounds: 3,
      chatSampler: async () => [],
      recommendSampler: async () => recommendRounds[recommendIndex++] || [],
      latestRecommendSampler: async () => latestRounds[latestIndex++] || []
    });

    assert.equal(result.summary.sampledCount, 6);
    assert.equal(result.summary.meetsMinimumSamples, true);
    assert.equal(result.summary.roundsCompleted, 2);
    assert.equal(result.summary.stableAfterFinalBatch, true);
    assert.equal(result.summary.stopReason, "minimum_met_and_stable_batch_reached");
    assert.equal(result.summary.pulls.length, 4);

    const persisted = JSON.parse(fs.readFileSync(result.outputPath, "utf8"));
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.summary.sampledCount, 6);
    assert.equal(persisted.samples.length, 6);
  } finally {
    if (previousHome === undefined) {
      delete process.env[ENV_HOME];
    } else {
      process.env[ENV_HOME] = previousHome;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

function buildSample(id, structureSignature) {
  return {
    sourceKind: "recommend_modal",
    captureSource: "recommend_tab_推荐",
    textHash: `text-${id}`,
    structureSignature,
    sectionTitles: ["求职意向"],
    structureSignaturePayload: {
      sourceKind: "recommend_modal",
      normalizedSectionIds: ["job_intent"]
    }
  };
}
