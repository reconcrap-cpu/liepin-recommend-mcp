import { sha1, normalizeText } from "../utils.js";

export const CV_SCHEMA_VERSION = "liepin_cv_v1";

export const CV_SECTION_DEFINITIONS = [
  { id: "job_match", label: "推荐职位", pattern: /推荐职位：?/u },
  { id: "job_intent", label: "求职意向", pattern: /求职意向/u },
  { id: "work_experience", label: "工作经历", pattern: /工作经历/u },
  { id: "project_experience", label: "项目经历", pattern: /项目经历/u },
  { id: "education", label: "教育经历", pattern: /教育经历/u },
  { id: "skills", label: "技能标签", pattern: /技能标签/u },
  { id: "certificates", label: "资格证书", pattern: /资格证书/u },
  { id: "languages", label: "语言能力", pattern: /语言能力/u },
  { id: "extra_info", label: "附加信息", pattern: /附加信息/u },
  { id: "attachment_resume", label: "附件简历", pattern: /附件简历(?:与个人作品)?/u },
  { id: "recruit_records", label: "人才招聘记录", pattern: /人才招聘记录/u },
  { id: "resume_notes", label: "简历备注", pattern: /简历备注/u }
];

const SECTION_ORDER = CV_SECTION_DEFINITIONS.map((definition) => definition.id);

export function parseCvSnapshot(snapshot = {}) {
  const fullText = String(snapshot.fullText || "").trim();
  const markers = findSectionMarkers(fullText);
  const chunks = markers.map((marker, index) => {
    const nextMarker = markers[index + 1] || null;
    const rawText = fullText.slice(marker.start, nextMarker ? nextMarker.start : fullText.length).trim();
    return {
      id: marker.id,
      title: marker.title,
      text: rawText,
      textLength: rawText.length,
      hash: sha1(rawText)
    };
  });

  const sections = buildEmptySections();
  for (const chunk of chunks) {
    const section = sections[chunk.id];
    section.present = true;
    section.titles.push(chunk.title);
    section.chunks.push(chunk);
    section.text = section.chunks.map((item) => item.text).filter(Boolean).join("\n\n");
    section.textLength = section.text.length;
    section.hash = sha1(section.text);
  }

  const profileText = markers.length > 0
    ? fullText.slice(0, markers[0].start).trim()
    : fullText;
  const presentSectionIds = SECTION_ORDER.filter((id) => sections[id].present);
  const missingSectionIds = SECTION_ORDER.filter((id) => !sections[id].present);
  const observedSectionIds = normalizeObservedSectionIds(snapshot.sectionTitles || []);

  return {
    schemaVersion: CV_SCHEMA_VERSION,
    source: {
      sourceKind: snapshot.sourceKind || "unknown",
      captureSource: snapshot.captureSource || snapshot.sourceKind || "unknown",
      recommendTab: snapshot.recommendTab || null
    },
    candidate: {
      label: normalizeText(snapshot.candidateLabel) || firstLine(fullText),
      profileText,
      profileTextLength: profileText.length,
      profileHash: sha1(profileText)
    },
    sections,
    orderedSections: chunks,
    coverage: {
      knownSectionIds: SECTION_ORDER,
      observedSectionIds,
      presentSectionIds,
      missingSectionIds,
      unmappedSectionTitles: collectUnmappedSectionTitles(snapshot.sectionTitles || [])
    },
    actions: {
      tokens: Array.isArray(snapshot.normalizedActionTokens) ? snapshot.normalizedActionTokens : [],
      hasOpenImButton: Boolean(snapshot.hasOpenImButton),
      hasPortfolioWrap: Boolean(snapshot.hasPortfolioWrap),
      hasAttachmentResume: sections.attachment_resume.present
    },
    raw: {
      textHash: snapshot.textHash || sha1(fullText),
      textLength: snapshot.textLength ?? fullText.length,
      htmlLength: snapshot.htmlLength ?? 0,
      structureSignature: snapshot.structureSignature || null
    }
  };
}

export function validateSurveyCvParsing(surveyPayload = {}) {
  const samples = Array.isArray(surveyPayload.samples) ? surveyPayload.samples : [];
  const parsed = samples.map((sample) => parseCvSnapshot(sample));
  const structures = new Map();
  const samplesMissingExpectedSections = [];
  for (const [index, cv] of parsed.entries()) {
    const sample = samples[index] || {};
    const key = cv.raw.structureSignature || cv.raw.textHash;
    const existing = structures.get(key) || {
      structureSignature: key,
      count: 0,
      sourceKinds: new Set(),
      presentSectionIds: new Set()
    };
    existing.count += 1;
    existing.sourceKinds.add(cv.source.sourceKind);
    for (const sectionId of cv.coverage.presentSectionIds) {
      existing.presentSectionIds.add(sectionId);
    }
    structures.set(key, existing);

    const expectedSectionIds = Array.isArray(sample.normalizedSectionIds)
      ? sample.normalizedSectionIds
      : cv.coverage.observedSectionIds;
    const missingSectionIds = expectedSectionIds.filter((sectionId) => !cv.coverage.presentSectionIds.includes(sectionId));
    if (missingSectionIds.length > 0) {
      samplesMissingExpectedSections.push({
        sampleIndex: index,
        structureSignature: key,
        sourceKind: cv.source.sourceKind,
        missingSectionIds
      });
    }
  }

  const structureRows = [...structures.values()].map((entry) => ({
    structureSignature: entry.structureSignature,
    count: entry.count,
    sourceKinds: [...entry.sourceKinds].sort(),
    presentSectionIds: [...entry.presentSectionIds].sort()
  }));

  return {
    sampleCount: samples.length,
    parsedCount: parsed.length,
    structureCount: structureRows.length,
    expectedStructureCount: surveyPayload.summary?.uniqueStructureCount ?? null,
    allExpectedStructuresParsed: surveyPayload.summary?.uniqueStructureCount == null
      ? true
      : structureRows.length === surveyPayload.summary.uniqueStructureCount,
    allExpectedSectionsPresent: samplesMissingExpectedSections.length === 0,
    samplesMissingExpectedSections,
    sectionIds: SECTION_ORDER,
    structureRows
  };
}

function buildEmptySections() {
  return Object.fromEntries(SECTION_ORDER.map((id) => [id, {
    id,
    present: false,
    titles: [],
    chunks: [],
    text: "",
    textLength: 0,
    hash: sha1("")
  }]));
}

function findSectionMarkers(text) {
  const markers = [];
  for (let index = 0; index < text.length; index += 1) {
    const tail = text.slice(index);
    const match = matchSectionAt(tail);
    if (!match) continue;
    markers.push({
      id: match.id,
      title: match.title,
      start: index
    });
    index += Math.max(match.title.length - 1, 0);
  }
  return markers;
}

function matchSectionAt(text) {
  for (const definition of CV_SECTION_DEFINITIONS) {
    const match = definition.pattern.exec(text);
    if (match && match.index === 0) {
      return {
        id: definition.id,
        title: match[0]
      };
    }
  }
  return null;
}

function normalizeObservedSectionIds(sectionTitles) {
  const ids = [];
  for (const title of sectionTitles) {
    const definition = CV_SECTION_DEFINITIONS.find((candidate) => candidate.pattern.test(String(title || "")));
    if (definition && !ids.includes(definition.id)) {
      ids.push(definition.id);
    }
  }
  return ids;
}

function collectUnmappedSectionTitles(sectionTitles) {
  return sectionTitles
    .map((title) => normalizeText(title))
    .filter(Boolean)
    .filter((title) => !CV_SECTION_DEFINITIONS.some((definition) => definition.pattern.test(title)))
    .slice(0, 20);
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/u).map((line) => normalizeText(line)).find(Boolean) || "";
}
