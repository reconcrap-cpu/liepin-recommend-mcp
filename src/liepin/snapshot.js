import { sha1, stableStringify } from "../utils.js";

export function normalizeSnapshot(snapshot) {
  const fullText = String(snapshot?.fullText || "").trim();
  const sectionTitles = Array.isArray(snapshot?.sectionTitles)
    ? snapshot.sectionTitles.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const normalizedSectionIds = normalizeSectionIds(sectionTitles);
  const normalizedActionTokens = normalizeActionTokens(snapshot?.actionLabels || []);
  const signaturePayload = {
    sourceKind: snapshot?.sourceKind || "unknown",
    rootClasses: normalizeRootClasses(snapshot?.rootClasses || []),
    normalizedSectionIds,
    hasPortfolioWrap: Boolean(snapshot?.hasPortfolioWrap),
    hasOpenImButton: Boolean(snapshot?.hasOpenImButton),
    hasIndividualInfo: Boolean(snapshot?.hasIndividualInfo),
    hasAttachmentResume: normalizedSectionIds.includes("attachment_resume"),
    hasProjectSection: normalizedSectionIds.includes("project_experience"),
    hasSkillSection: normalizedSectionIds.includes("skills"),
    hasCertificateSection: normalizedSectionIds.includes("certificates"),
    hasLanguageSection: normalizedSectionIds.includes("languages"),
    hasExtraInfoSection: normalizedSectionIds.includes("extra_info"),
    normalizedActionTokens
  };
  return {
    ...snapshot,
    sectionTitles,
    normalizedSectionIds,
    normalizedActionTokens,
    fullText,
    textHash: sha1(fullText),
    textLength: fullText.length,
    structureSignature: sha1(stableStringify(signaturePayload)),
    structureSignaturePayload: signaturePayload
  };
}

export function buildTaxonomy(samples = []) {
  const groups = new Map();
  for (const sample of samples) {
    const key = sample.structureSignature;
    const existing = groups.get(key) || {
      structureSignature: key,
      count: 0,
      sources: new Set(),
      sectionTitles: sample.sectionTitles,
      payload: sample.structureSignaturePayload
    };
    existing.count += 1;
    existing.sources.add(sample.sourceKind);
    groups.set(key, existing);
  }
  return [...groups.values()]
    .map((entry) => ({
      ...entry,
      sources: [...entry.sources]
    }))
    .sort((left, right) => right.count - left.count);
}

function normalizeSectionIds(sectionTitles = []) {
  const knownSections = [
    ["job_match", /^推荐职位/u],
    ["job_intent", /^求职意向/u],
    ["work_experience", /^工作经历/u],
    ["project_experience", /^项目经历/u],
    ["education", /^教育经历/u],
    ["skills", /^技能标签/u],
    ["certificates", /^资格证书/u],
    ["languages", /^语言能力/u],
    ["extra_info", /^附加信息/u],
    ["attachment_resume", /^附件简历/u],
    ["recruit_records", /^人才招聘记录/u],
    ["resume_notes", /^简历备注/u]
  ];
  const normalized = [];
  for (const title of sectionTitles) {
    for (const [id, matcher] of knownSections) {
      if (matcher.test(title)) {
        if (!normalized.includes(id)) normalized.push(id);
        break;
      }
    }
  }
  return normalized;
}

function normalizeActionTokens(actionLabels = []) {
  const joined = actionLabels.join("\n");
  const tokens = [];
  const rules = [
    ["ask_attachment", /向TA索要/u],
    ["open_chat", /立即沟通|继续沟通/u],
    ["super_chat", /超级聊聊/u],
    ["intent_contact", /意向沟通|发起意向沟通/u],
    ["get_phone", /获取电话|手机号|索要手机/u],
    ["ask_wechat", /索要微信/u],
    ["view_resume", /看简历|浏览简历/u],
    ["save", /保存/u],
    ["favorite", /收藏/u],
    ["print", /打印/u],
    ["report", /举报/u],
    ["background_check", /背景调查/u]
  ];
  for (const [token, matcher] of rules) {
    if (matcher.test(joined)) tokens.push(token);
  }
  return tokens;
}

function normalizeRootClasses(rootClasses = []) {
  return rootClasses
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => (
      value.includes("printable")
      || value.includes("resume-detail")
      || value.includes("wrap--")
      || value.includes("content-body")
    ))
    .sort();
}
