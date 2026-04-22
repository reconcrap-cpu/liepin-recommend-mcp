import { sha1 } from "../utils.js";
import { CV_SCHEMA_VERSION, parseCvSnapshot } from "./cv-parser.js";

export const SCREEN_INPUT_SCHEMA_VERSION = "liepin_screen_input_v1";

export function buildCvScreeningInput(snapshotOrCv, {
  maxPayloadChars = null
} = {}) {
  const cv = snapshotOrCv?.schemaVersion === CV_SCHEMA_VERSION
    ? snapshotOrCv
    : parseCvSnapshot(snapshotOrCv);
  const sections = buildPayloadSections(cv);
  const payloadText = renderPayloadText(cv, sections);
  const truncated = Number.isFinite(maxPayloadChars) && maxPayloadChars > 0 && payloadText.length > maxPayloadChars;
  const finalPayloadText = truncated ? payloadText.slice(0, maxPayloadChars) : payloadText;
  const payloadSectionIds = new Set(sections.map((section) => section.id));
  const missingParsedSectionIds = cv.coverage.presentSectionIds.filter((sectionId) => !payloadSectionIds.has(sectionId));

  return {
    schemaVersion: SCREEN_INPUT_SCHEMA_VERSION,
    cvSchemaVersion: cv.schemaVersion,
    source: cv.source,
    candidate: cv.candidate,
    sections,
    payloadText: finalPayloadText,
    manifest: {
      sourceTextHash: cv.raw.textHash,
      sourceTextLength: cv.raw.textLength,
      payloadHash: sha1(finalPayloadText),
      payloadCharCount: finalPayloadText.length,
      untruncatedPayloadHash: sha1(payloadText),
      untruncatedPayloadCharCount: payloadText.length,
      truncated,
      maxPayloadChars,
      sectionCount: sections.length,
      sectionCharCount: sections.reduce((sum, section) => sum + section.charCount, 0),
      sectionHashes: sections.map((section) => ({
        ordinal: section.ordinal,
        id: section.id,
        title: section.title,
        charCount: section.charCount,
        hash: section.hash
      })),
      parsedPresentSectionIds: cv.coverage.presentSectionIds,
      payloadSectionIds: [...payloadSectionIds],
      missingParsedSectionIds
    }
  };
}

export function auditCvPayloadCoverage(snapshotOrCv, options = {}) {
  const screenInput = buildCvScreeningInput(snapshotOrCv, options);
  return {
    sourceKind: screenInput.source.sourceKind,
    captureSource: screenInput.source.captureSource,
    payloadHash: screenInput.manifest.payloadHash,
    payloadCharCount: screenInput.manifest.payloadCharCount,
    sectionCount: screenInput.manifest.sectionCount,
    parsedPresentSectionIds: screenInput.manifest.parsedPresentSectionIds,
    payloadSectionIds: screenInput.manifest.payloadSectionIds,
    missingParsedSectionIds: screenInput.manifest.missingParsedSectionIds,
    allParsedSectionsIncluded: screenInput.manifest.missingParsedSectionIds.length === 0,
    truncated: screenInput.manifest.truncated,
    passed: screenInput.manifest.missingParsedSectionIds.length === 0 && !screenInput.manifest.truncated
  };
}

export function auditSurveyPayloadCoverage(surveyPayload = {}, {
  sampleLimit = 10,
  maxPayloadChars = null
} = {}) {
  const samples = Array.isArray(surveyPayload.samples) ? surveyPayload.samples : [];
  const selectedSamples = selectDiverseSamples(samples, sampleLimit);
  const audits = selectedSamples.map((sample, index) => ({
    sampleIndex: sample.sampleIndex,
    auditIndex: index,
    structureSignature: sample.structureSignature || null,
    ...auditCvPayloadCoverage(sample, { maxPayloadChars })
  }));
  return {
    requestedSampleLimit: sampleLimit,
    auditedSampleCount: audits.length,
    uniqueStructureCount: new Set(audits.map((audit) => audit.structureSignature).filter(Boolean)).size,
    allAuditsPassed: audits.every((audit) => audit.passed),
    failedAudits: audits.filter((audit) => !audit.passed),
    audits
  };
}

function buildPayloadSections(cv) {
  const sections = [];
  if (cv.candidate.profileText) {
    sections.push({
      ordinal: sections.length,
      id: "profile",
      title: "profile",
      text: cv.candidate.profileText,
      charCount: cv.candidate.profileText.length,
      hash: sha1(cv.candidate.profileText)
    });
  }

  for (const section of cv.orderedSections) {
    sections.push({
      ordinal: sections.length,
      id: section.id,
      title: section.title,
      text: section.text,
      charCount: section.textLength,
      hash: section.hash
    });
  }
  return sections;
}

function renderPayloadText(cv, sections) {
  const header = [
    `schema=${SCREEN_INPUT_SCHEMA_VERSION}`,
    `source=${cv.source.captureSource}`,
    `candidate=${cv.candidate.label}`,
    `source_text_hash=${cv.raw.textHash}`
  ].join("\n");
  const body = sections.map((section) => [
    `\n[section:${section.ordinal}:${section.id}:${section.title}]`,
    section.text
  ].join("\n")).join("\n");
  return `${header}\n${body}`.trim();
}

function selectDiverseSamples(samples, sampleLimit) {
  const limit = Math.max(0, Number.parseInt(String(sampleLimit ?? 10), 10) || 10);
  const selected = [];
  const seenStructures = new Set();
  for (const [index, sample] of samples.entries()) {
    if (selected.length >= limit) break;
    const structure = sample.structureSignature || sample.textHash || String(index);
    if (seenStructures.has(structure)) continue;
    seenStructures.add(structure);
    selected.push({
      ...sample,
      sampleIndex: index
    });
  }
  if (selected.length >= limit) return selected;
  for (const [index, sample] of samples.entries()) {
    if (selected.length >= limit) break;
    if (selected.some((item) => item.sampleIndex === index)) continue;
    selected.push({
      ...sample,
      sampleIndex: index
    });
  }
  return selected;
}
