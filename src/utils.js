import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function toIsoNow() {
  return new Date().toISOString();
}

export function ensureDirSync(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
  return targetPath;
}

export function readJsonFile(targetPath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(targetPath, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonFile(targetPath, value) {
  ensureDirSync(path.dirname(targetPath));
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function appendNdjsonLine(targetPath, value) {
  ensureDirSync(path.dirname(targetPath));
  fs.appendFileSync(targetPath, `${JSON.stringify(value)}\n`, "utf8");
}

export function sha1(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

export function parsePositiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isAllCandidateLimit(value) {
  if (value === undefined || value === null || typeof value === "boolean") return false;
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return false;
  const compact = normalized.replace(/[\s_\-.,，。、:：;；!！?？'"`“”‘’()（）[\]【】]+/gu, "");
  if (!compact) return false;

  const exactAliases = new Set([
    "all",
    "全部",
    "所有",
    "全量",
    "不限",
    "不限制",
    "无限",
    "無限",
    "扫到底",
    "掃到底",
    "扫完",
    "掃完",
    "到底"
  ]);
  if (exactAliases.has(compact)) return true;

  return [
    "allcandidates",
    "everyone",
    "scanall",
    "scanuntilbottom",
    "scanthroughall",
    "全部人选",
    "全部候选人",
    "所有人选",
    "所有候选人",
    "扫完全部",
    "扫完所有",
    "扫描全部",
    "扫描所有",
    "扫到列表底部",
    "扫到最后",
    "直到列表底部",
    "一直扫到",
    "掃完全部",
    "掃完所有"
  ].some((alias) => compact.includes(alias));
}

export function parseCandidateLimit(value, fallback = null) {
  if (isAllCandidateLimit(value)) return null;
  return parsePositiveInteger(value, fallback);
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function stableStringify(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((accumulator, key) => {
    accumulator[key] = sortDeep(value[key]);
    return accumulator;
  }, {});
}
