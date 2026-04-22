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
