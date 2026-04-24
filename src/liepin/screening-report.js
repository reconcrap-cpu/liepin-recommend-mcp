import fs from "node:fs";
import path from "node:path";

import { RUN_WORKFLOWS } from "../constants.js";
import { ensureDirSync, normalizeText } from "../utils.js";

const INPUT_SUMMARY_HEADER = ["运行输入字段", "运行输入值"].join(",");
const CSV_HEADER = [
  "姓名",
  "最高学历学校",
  "最高学历专业",
  "最近工作公司",
  "最近工作职位",
  "评估通过详细原因",
  "处理结果",
  "判断依据(CoT)",
  "推荐阶段CoT",
  "聊天阶段CoT",
  "动作执行结果",
  "简历来源",
  "原始判定通过",
  "最终判定通过",
  "错误码",
  "错误信息",
  "候选人ID"
].join(",");

const SCREENING_WORKFLOWS = new Set([
  RUN_WORKFLOWS.RECOMMEND_DRY_RUN_SCREENING,
  RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING,
  RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
  RUN_WORKFLOWS.SEARCH_CHAT_CHAIN
]);

const SENSITIVE_INPUT_KEYS = new Set([
  "apikey",
  "api_key",
  "baseurl",
  "base_url",
  "model"
]);

export function writeScreeningCsvReport({
  targetPath,
  workflowResult = {},
  input = {}
} = {}) {
  const csv = buildScreeningCsvReport({ workflowResult, input });
  if (csv === null || !targetPath) return null;
  ensureDirSync(path.dirname(targetPath));
  fs.writeFileSync(targetPath, csv, "utf8");
  return targetPath;
}

export function buildScreeningCsvReport({
  workflowResult = {},
  input = {}
} = {}) {
  const workflow = resolveWorkflow(workflowResult);
  if (!SCREENING_WORKFLOWS.has(workflow)) return null;
  const detail = workflowResult.result || workflowResult;
  const rows = buildCandidateRows(workflow, Array.isArray(detail.items) ? detail.items : []);
  const lines = [];
  const inputRows = buildInputSummaryRows(input);
  if (inputRows.length > 0) {
    lines.push(INPUT_SUMMARY_HEADER);
    for (const [key, value] of inputRows) {
      lines.push([csvEscape(key), csvEscape(value)].join(","));
    }
    lines.push("");
  }
  lines.push(CSV_HEADER);
  for (const row of rows) {
    lines.push([
      row.name,
      row.school,
      row.major,
      row.company,
      row.position,
      row.passReason,
      row.outcome,
      row.cot,
      row.recommendCot,
      row.chatCot,
      row.actionTaken,
      row.resumeSource,
      row.rawPassed,
      row.finalPassed,
      row.errorCode,
      row.errorMessage,
      row.candidateId
    ].map(csvEscape).join(","));
  }
  return `\uFEFF${lines.join("\n")}\n`;
}

export function buildCandidateRows(workflow, items = []) {
  return items
    .map((item) => buildCandidateRow(workflow, item))
    .filter(Boolean);
}

function buildCandidateRow(workflow, item = {}) {
  if (!wasLlmScreened(item)) return null;
  const recommendDecision = item.recommendDecision || (
    workflow !== RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING ? item.decision : null
  );
  const chatDecision = item.chatDecision || (
    workflow === RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING ? item.decision : null
  );
  const finalDecision = chatDecision || recommendDecision || item.decision || null;
  const recommendCot = normalizeText(item.recommendReasoningText || item.reasoningText);
  const chatCot = normalizeText(item.chatReasoningText || (
    workflow === RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING ? item.reasoningText : ""
  ));
  const cot = chatCot || recommendCot || normalizeText(item.reasoningText);
  const finalPassed = finalDecision?.decision === "pass";
  const action = resolveActionTaken(item);
  const candidate = item.candidate || {};
  const beforeState = item.beforeState || {};
  const label = firstNonEmpty(
    candidate.name,
    item.candidateLabel,
    candidate.label,
    beforeState.rowText,
    item.rowText,
    item.chatState?.rowText,
    item.searchSnapshot?.candidateLabel,
    item.recommendSnapshot?.candidateLabel
  );

  return {
    name: label,
    school: "",
    major: "",
    company: "",
    position: "",
    passReason: "",
    outcome: resolveOutcome(item, finalDecision),
    cot,
    recommendCot,
    chatCot,
    actionTaken: action,
    resumeSource: resolveResumeSource(workflow, item),
    rawPassed: finalDecision ? String(finalDecision.decision === "pass") : "",
    finalPassed: finalDecision ? String(finalPassed) : "",
    errorCode: firstNonEmpty(item.errorCode, item.error_code, item.violations?.[0]?.code),
    errorMessage: firstNonEmpty(item.errorMessage, item.error_message, item.violations?.[0]?.reason),
    candidateId: firstNonEmpty(candidate.resumeId, item.rowKey, item.chatState?.rowKey, candidate.textHash, item.textHash)
  };
}

function wasLlmScreened(item = {}) {
  return Boolean(item.llmCalled || item.recommendLlmCalled || item.chatLlmCalled);
}

function resolveWorkflow(workflowResult = {}) {
  return normalizeText(workflowResult.workflow || workflowResult.result?.workflow || "");
}

function resolveOutcome(item = {}, finalDecision = null) {
  if (item.status) return item.status;
  if (finalDecision?.decision === "pass") return "passed";
  if (finalDecision?.decision === "fail") return "skipped";
  return "unknown";
}

function resolveActionTaken(item = {}) {
  return firstNonEmpty(
    item.chatAction?.status,
    item.chatAction?.action,
    item.recommendChatAction?.status,
    item.wouldPostAction,
    item.decision?.post_action,
    item.recommendDecision?.post_action,
    item.chatDecision?.post_action,
    "none"
  );
}

function resolveResumeSource(workflow, item = {}) {
  if (workflow === RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING) return "chat";
  if (workflow === RUN_WORKFLOWS.SEARCH_CHAT_CHAIN) return "search";
  if (workflow === RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN && item.chatLlmCalled) return "recommend_chat";
  return "recommend";
}

function buildInputSummaryRows(input = {}) {
  const rows = [];
  flattenInput(input, "", rows);
  return rows;
}

function flattenInput(value, prefix, rows) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    rows.push([prefix, value.map((item) => normalizeScalar(item)).join(" | ")]);
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = normalizeText(key);
      if (!normalizedKey || isSensitiveInputKey(normalizedKey)) continue;
      flattenInput(nested, prefix ? `${prefix}.${normalizedKey}` : normalizedKey, rows);
    }
    return;
  }
  if (!prefix || isSensitiveInputKey(prefix)) return;
  rows.push([prefix, normalizeScalar(value)]);
}

function isSensitiveInputKey(key) {
  const last = normalizeText(key).split(".").at(-1).replace(/[-\s]/g, "").toLowerCase();
  return SENSITIVE_INPUT_KEYS.has(last);
}

function normalizeScalar(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return normalizeText(value);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return "";
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}
