import path from "node:path";

import {
  DEFAULT_TARGET_SURVEY_BATCH,
  DEFAULT_TARGET_SURVEY_MAX_ROUNDS,
  DEFAULT_TARGET_SURVEY_MIN,
  DEFAULT_TARGET_SURVEY_PER_PASS
} from "../constants.js";
import { ensureRuntimeLayout } from "../config.js";
import { sha1, toIsoNow, writeJsonFile } from "../utils.js";
import { buildTaxonomy } from "./snapshot.js";

export async function runCvStructureSurvey({
  recommendSampler,
  latestRecommendSampler = null,
  chatSampler,
  workspaceRoot,
  minimumSamples = DEFAULT_TARGET_SURVEY_MIN,
  batchSize = DEFAULT_TARGET_SURVEY_BATCH,
  perPassLimit = DEFAULT_TARGET_SURVEY_PER_PASS,
  maxRounds = DEFAULT_TARGET_SURVEY_MAX_ROUNDS,
  onProgress = null
}) {
  const layout = ensureRuntimeLayout(workspaceRoot);
  const outputPath = path.join(layout.researchDir, `cv-structure-survey-${Date.now()}.json`);

  const collected = [];
  const seenSampleHashes = new Set();
  const seenSignatures = new Set();
  const pulls = [];
  const completedBatches = [];
  let workingBatch = createWorkingBatch();
  let roundsCompleted = 0;
  let stopReason = "max_rounds_reached";

  const writeCheckpoint = (status, event = {}) => {
    const payload = buildSurveyPayload({
      status,
      collected,
      minimumSamples,
      batchSize,
      perPassLimit,
      maxRounds,
      roundsCompleted,
      stopReason,
      pulls,
      completedBatches,
      workingBatch
    });
    writeJsonFile(outputPath, payload);
    if (typeof onProgress === "function") {
      onProgress({
        ...event,
        status,
        outputPath,
        sampledCount: payload.summary.sampledCount,
        uniqueStructureCount: payload.summary.uniqueStructureCount,
        meetsMinimumSamples: payload.summary.meetsMinimumSamples,
        stableAfterFinalBatch: payload.summary.stableAfterFinalBatch,
        stopReason: payload.summary.stopReason
      });
    }
  };

  writeCheckpoint("running", { phase: "started" });

  if (typeof chatSampler === "function") {
    const rawChatSamples = await chatSampler(Math.min(5, batchSize));
    const chatPull = recordPull({
      round: 0,
      sourceLabel: "chat_resume_detail",
      requestedLimit: Math.min(5, batchSize),
      samples: rawChatSamples,
      collected,
      seenSampleHashes,
      seenSignatures,
      batchSize,
      completedBatches,
      workingBatch,
      minimumSamples
    });
    pulls.push(chatPull);
    if (chatPull.shouldStop) {
      stopReason = "minimum_met_and_stable_batch_reached";
    }
    writeCheckpoint("running", { phase: "after_chat_pull", pull: chatPull });
  }

  for (let round = 1; round <= maxRounds && stopReason !== "minimum_met_and_stable_batch_reached"; round += 1) {
    roundsCompleted = round;
    let roundNewUnique = 0;

    const recommendPull = recordPull({
      round,
      sourceLabel: "recommend_tab_推荐",
      requestedLimit: perPassLimit,
      samples: await recommendSampler(perPassLimit),
      collected,
      seenSampleHashes,
      seenSignatures,
      batchSize,
      completedBatches,
      workingBatch,
      minimumSamples
    });
    pulls.push(recommendPull);
    roundNewUnique += recommendPull.newUniqueSamples;
    writeCheckpoint("running", { phase: "after_recommend_pull", round, pull: recommendPull });
    if (recommendPull.shouldStop) {
      stopReason = "minimum_met_and_stable_batch_reached";
      break;
    }

    if (typeof latestRecommendSampler === "function") {
      const latestPull = recordPull({
        round,
        sourceLabel: "recommend_tab_最新",
        requestedLimit: perPassLimit,
        samples: await latestRecommendSampler(perPassLimit),
        collected,
        seenSampleHashes,
        seenSignatures,
        batchSize,
        completedBatches,
        workingBatch,
        minimumSamples
      });
      pulls.push(latestPull);
      roundNewUnique += latestPull.newUniqueSamples;
      writeCheckpoint("running", { phase: "after_latest_pull", round, pull: latestPull });
      if (latestPull.shouldStop) {
        stopReason = "minimum_met_and_stable_batch_reached";
        break;
      }
    }

    if (roundNewUnique === 0) {
      stopReason = collected.length >= minimumSamples
        ? "minimum_met_but_no_new_unique_samples"
        : "no_new_unique_samples";
      break;
    }
  }

  if (workingBatch.samples.length > 0) {
    completedBatches.push(finalizeBatch(workingBatch, collected.length, true));
  }

  const payload = buildSurveyPayload({
    status: "completed",
    collected,
    minimumSamples,
    batchSize,
    perPassLimit,
    maxRounds,
    roundsCompleted,
    stopReason,
    pulls,
    completedBatches,
    workingBatch: null
  });

  writeJsonFile(outputPath, payload);
  if (typeof onProgress === "function") {
    onProgress({
      status: "completed",
      phase: "completed",
      outputPath,
      sampledCount: payload.summary.sampledCount,
      uniqueStructureCount: payload.summary.uniqueStructureCount,
      meetsMinimumSamples: payload.summary.meetsMinimumSamples,
      stableAfterFinalBatch: payload.summary.stableAfterFinalBatch,
      stopReason: payload.summary.stopReason
    });
  }
  return {
    outputPath,
    summary: payload.summary
  };
}

function buildSurveyPayload({
  status,
  collected,
  minimumSamples,
  batchSize,
  perPassLimit,
  maxRounds,
  roundsCompleted,
  stopReason,
  pulls,
  completedBatches,
  workingBatch
}) {
  const batches = snapshotBatches(completedBatches, workingBatch, collected.length);
  const taxonomy = buildTaxonomy(collected);
  const summary = {
    sampledCount: collected.length,
    uniqueStructureCount: taxonomy.length,
    minimumSamples,
    meetsMinimumSamples: collected.length >= minimumSamples,
    batchSize,
    perPassLimit,
    maxRounds,
    roundsCompleted,
    stableAfterFinalBatch: hasStableFinalBatch(batches, batchSize),
    stopReason,
    pulls,
    batches,
    sampleHash: sha1(JSON.stringify(collected.map((item) => item.textHash))),
    taxonomy
  };
  return {
    status,
    updatedAt: toIsoNow(),
    summary,
    samples: collected
  };
}

function recordPull({
  round,
  sourceLabel,
  requestedLimit,
  samples,
  collected,
  seenSampleHashes,
  seenSignatures,
  batchSize,
  completedBatches,
  workingBatch,
  minimumSamples
}) {
  const rawSamples = Array.isArray(samples) ? samples : [];
  let newUniqueSamples = 0;
  let duplicateSamples = 0;
  let newStructureSamples = 0;
  let shouldStop = false;

  for (const sample of rawSamples) {
    if (seenSampleHashes.has(sample.textHash)) {
      duplicateSamples += 1;
      continue;
    }
    seenSampleHashes.add(sample.textHash);
    collected.push(sample);
    newUniqueSamples += 1;

    const isNewStructure = !seenSignatures.has(sample.structureSignature);
    if (isNewStructure) {
      seenSignatures.add(sample.structureSignature);
      newStructureSamples += 1;
    }

    workingBatch.samples.push(sample);
    workingBatch.sourceLabels.add(sample.captureSource || sourceLabel);
    if (isNewStructure) {
      workingBatch.newStructures += 1;
    }

    if (workingBatch.samples.length >= batchSize) {
      completedBatches.push(finalizeBatch(workingBatch, collected.length, false));
      const lastBatch = completedBatches[completedBatches.length - 1];
      resetWorkingBatch(workingBatch);
      if (collected.length >= minimumSamples && lastBatch.newStructures === 0) {
        shouldStop = true;
        break;
      }
    }
  }

  return {
    round,
    sourceLabel,
    requestedLimit,
    returnedSamples: rawSamples.length,
    newUniqueSamples,
    duplicateSamples,
    newStructureSamples,
    uniqueSampleCountAfterPull: collected.length,
    shouldStop
  };
}

function createWorkingBatch() {
  return {
    samples: [],
    sourceLabels: new Set(),
    newStructures: 0
  };
}

function resetWorkingBatch(batch) {
  batch.samples = [];
  batch.sourceLabels = new Set();
  batch.newStructures = 0;
}

function finalizeBatch(batch, acceptedCount, partial) {
  return {
    sourceKind: [...batch.sourceLabels],
    pulled: batch.samples.length,
    accepted: acceptedCount,
    newStructures: batch.newStructures,
    partial
  };
}

function snapshotBatches(completedBatches, workingBatch, acceptedCount) {
  const batches = [...completedBatches];
  if (workingBatch?.samples?.length > 0) {
    batches.push(finalizeBatch(workingBatch, acceptedCount, true));
  }
  return batches;
}

function hasStableFinalBatch(batches, batchSize) {
  if (batches.length === 0) return false;
  const lastFullBatch = [...batches].reverse().find((batch) => !batch.partial);
  if (!lastFullBatch) return false;
  return lastFullBatch.pulled >= batchSize && lastFullBatch.newStructures === 0;
}
