import assert from "node:assert/strict";
import test from "node:test";

import { auditSurveyPayloadCoverage, buildCvScreeningInput } from "./cv-payload.js";

test("buildCvScreeningInput includes every parsed section with hashes", () => {
  const input = buildCvScreeningInput({
    sourceKind: "recommend_modal",
    captureSource: "recommend_tab_推荐",
    candidateLabel: "候选人A",
    fullText: [
      "候选人A 在线",
      "求职意向",
      "人力资源",
      "工作经历",
      "公司A",
      "教育经历",
      "学校A"
    ].join("\n"),
    normalizedSectionIds: ["job_intent", "work_experience", "education"],
    sectionTitles: ["求职意向", "工作经历", "教育经历"]
  });

  assert.equal(input.schemaVersion, "liepin_screen_input_v1");
  assert.equal(input.manifest.truncated, false);
  assert.equal(input.manifest.missingParsedSectionIds.length, 0);
  assert.ok(input.manifest.payloadHash);
  assert.ok(input.sections.every((section) => section.hash && section.charCount >= 0));
  assert.deepEqual(input.manifest.parsedPresentSectionIds, ["job_intent", "work_experience", "education"]);
});

test("auditSurveyPayloadCoverage selects diverse samples and fails truncation", () => {
  const survey = {
    samples: [
      buildSample("sig-a", "求职意向\nA\n教育经历\nA"),
      buildSample("sig-b", "求职意向\nB\n工作经历\nB"),
      buildSample("sig-a", "求职意向\nC\n语言能力\nC")
    ]
  };

  const ok = auditSurveyPayloadCoverage(survey, { sampleLimit: 2 });
  assert.equal(ok.auditedSampleCount, 2);
  assert.equal(ok.uniqueStructureCount, 2);
  assert.equal(ok.allAuditsPassed, true);

  const truncated = auditSurveyPayloadCoverage(survey, { sampleLimit: 1, maxPayloadChars: 10 });
  assert.equal(truncated.allAuditsPassed, false);
  assert.equal(truncated.failedAudits[0].truncated, true);
});

function buildSample(structureSignature, fullText) {
  return {
    sourceKind: "recommend_modal",
    structureSignature,
    fullText,
    normalizedSectionIds: ["job_intent"],
    sectionTitles: ["求职意向"]
  };
}
