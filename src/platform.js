import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DEFAULT_DEBUG_PORT, SERVER_NAME, TOOL_NAMES } from "./constants.js";
import {
  ensureRuntimeLayout,
  getScreeningConfigResolution,
  writeScreeningConfigTemplate
} from "./config.js";
import { runDoctor } from "./doctor.js";
import { ensureDirSync, normalizeText, toIsoNow, writeJsonFile } from "./utils.js";

export const EXTERNAL_AGENT_CONFIG_SCHEMA_VERSION = "liepin_external_agent_config_v1";
export const SKILL_EXPORT_SCHEMA_VERSION = "liepin_skill_export_v1";
export const defaultSkillName = "liepin-recommend-pipeline";
export const chatSkillName = "liepin-chat";
export const searchSkillName = "liepin-search";
export const bundledSkillNames = [defaultSkillName, chatSkillName, searchSkillName];

const currentFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFilePath), "..");
const packageJsonPath = path.join(packageRoot, "package.json");
const supportedExternalAgents = ["cursor", "trae", "trae-cn", "claude", "openclaw"];
const externalMcpTargetsEnv = "LIEPIN_MCP_CONFIG_TARGETS";
const externalSkillDirsEnv = "LIEPIN_EXTERNAL_SKILL_DIRS";
const liepinPackageName = "@reconcrap/liepin-mcp";
const legacyLiepinPackageName = "@reconcrap/liepin-recommend-mcp";
const liepinBinaryName = "liepin-mcp";
const legacyServerNames = ["liepin-recommend-mcp"];

function getPackageVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return typeof parsed?.version === "string" ? parsed.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const packageVersion = getPackageVersion();

function isInstalledPackageRoot(rootPath = packageRoot) {
  const normalized = path.resolve(String(rootPath || ""))
    .replace(/\\/g, "/")
    .toLowerCase();
  return (
    normalized.includes("/appdata/local/npm-cache/_npx/")
    || normalized.includes("/node_modules/liepin-mcp")
    || normalized.includes("/node_modules/@reconcrap/liepin-mcp")
    || normalized.includes("/node_modules/@reconcrap/liepin-recommend-mcp")
  );
}

function getDefaultMcpPackageSpecifier(options = {}) {
  const version = String(options.packageVersion || packageVersion).trim();
  const rootPath = options.packageRootPath || packageRoot;
  if (version && version !== "0.0.0" && isInstalledPackageRoot(rootPath)) {
    return `${liepinPackageName}@${version}`;
  }
  return `${liepinPackageName}@latest`;
}

function getLocalSourceLaunchArgs() {
  return [path.join(packageRoot, "bin", "liepin-recommend-mcp.js"), "start"];
}

function getCodexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

function getSkillSourceDir(name = defaultSkillName) {
  return path.join(packageRoot, "skills", name);
}

function getSkillTargetDir(name = defaultSkillName) {
  return path.join(getCodexHome(), "skills", name);
}

function getSkillVersionMarkerPath(name = defaultSkillName) {
  return path.join(getSkillTargetDir(name), ".installed-version");
}

function readInstalledSkillVersion(name = defaultSkillName) {
  const markerPath = getSkillVersionMarkerPath(name);
  if (!pathExists(markerPath)) return null;
  try {
    return fs.readFileSync(markerPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeInstalledSkillVersion(name, version) {
  const markerPath = getSkillVersionMarkerPath(name);
  ensureDirSync(path.dirname(markerPath));
  fs.writeFileSync(markerPath, `${version}\n`, "utf8");
}

function pathExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function readJsonObjectFileSafe(filePath) {
  if (!pathExists(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fallback below.
  }
  return {};
}

function dedupePaths(items) {
  const result = [];
  const seen = new Set();
  for (const item of items || []) {
    const raw = String(item ?? "").trim();
    if (!raw) continue;
    const resolved = path.resolve(raw);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function dedupeLower(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function discoverAppDataDirsByPattern(baseDir, pattern) {
  try {
    if (!pathExists(baseDir)) return [];
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function parsePathListFromEnv(raw) {
  if (!raw) return [];
  const text = String(raw).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return dedupePaths(parsed.filter(Boolean));
    }
  } catch {
    // Fallback to delimiter split.
  }
  return dedupePaths(text.split(path.delimiter).map((item) => item.trim()).filter(Boolean));
}

function normalizeAgentName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "claude-code") return "claude";
  return raw;
}

function parseAgentTargets(rawValue) {
  if (!rawValue) return supportedExternalAgents.slice();
  const raw = String(rawValue).trim().toLowerCase();
  if (!raw || raw === "all") return supportedExternalAgents.slice();
  const candidates = raw.split(",").map(normalizeAgentName).filter(Boolean);
  const unique = [...new Set(candidates)];
  const invalid = unique.filter((item) => !supportedExternalAgents.includes(item));
  if (invalid.length > 0) {
    throw new Error(`Unsupported --agent value: ${invalid.join(", ")}. Supported: ${supportedExternalAgents.join(", ")}, all`);
  }
  return unique;
}

function buildExternalMcpLaunchConfig(options = {}) {
  const explicitCommand = normalizeText(options.command);
  const useLocalSource = !explicitCommand && !isInstalledPackageRoot(options.packageRootPath || packageRoot);
  const command = explicitCommand || (useLocalSource ? "node" : "npx");
  const explicitArgs = options.args;
  const launchArgs = Array.isArray(explicitArgs) && explicitArgs.length > 0
    ? explicitArgs
    : useLocalSource
      ? getLocalSourceLaunchArgs()
    : command === liepinBinaryName
      ? ["start"]
      : ["-y", getDefaultMcpPackageSpecifier(options), "start"];
  const launchConfig = {
    command,
    args: launchArgs
  };
  const resolvedWorkspaceRoot = normalizeText(options.workspaceRoot || options.workspace_root)
    ? path.resolve(options.workspaceRoot || options.workspace_root)
    : null;
  const explicitEnv = options.env && typeof options.env === "object" && !Array.isArray(options.env)
    ? options.env
    : null;
  const launchEnv = {
    ...(resolvedWorkspaceRoot ? { LIEPIN_WORKSPACE_ROOT: resolvedWorkspaceRoot } : {}),
    ...(explicitEnv || {})
  };
  if (Object.keys(launchEnv).length > 0) {
    launchConfig.env = launchEnv;
  }
  return launchConfig;
}

function buildMcpConfigFileContent(options = {}) {
  const serverName = normalizeText(options.serverName || options.server_name) || SERVER_NAME;
  return {
    mcpServers: {
      [serverName]: buildExternalMcpLaunchConfig(options)
    }
  };
}

function getKnownExternalMcpConfigPathsByAgent() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const traeDirNames = dedupeLower([
    "Trae",
    "Trae CN",
    "TraeCN",
    "trae-cn",
    "trae_cn",
    ...discoverAppDataDirsByPattern(appData, /^trae(?:[\s\-_]?cn)?$/i)
  ]);
  const traeConfigPaths = traeDirNames.map((dir) => path.join(appData, dir, "User", "mcp.json"));
  return {
    cursor: [path.join(appData, "Cursor", "User", "mcp.json"), path.join(home, ".cursor", "mcp.json")],
    trae: [...traeConfigPaths, path.join(home, ".trae", "mcp.json"), path.join(home, ".trae-cn", "mcp.json")],
    "trae-cn": [...traeConfigPaths, path.join(home, ".trae-cn", "mcp.json"), path.join(home, ".trae", "mcp.json")],
    claude: [path.join(home, ".claude", "mcp.json")],
    openclaw: [path.join(home, ".openclaw", "mcp.json")]
  };
}

function resolveExternalMcpConfigTargets(options = {}) {
  const fromEnv = parsePathListFromEnv(process.env[externalMcpTargetsEnv]);
  const pathMap = getKnownExternalMcpConfigPathsByAgent();
  const agents = parseAgentTargets(options.agent);
  const knownCandidates = agents.flatMap((agent) => pathMap[agent] || []);
  const known = dedupePaths(knownCandidates).filter((filePath) => {
    if (options.agent) return true;
    if (pathExists(filePath)) return true;
    return pathExists(path.dirname(filePath));
  });
  return dedupePaths([...fromEnv, ...known]);
}

function mergeMcpServerConfigFile(filePath, options = {}) {
  const nextConfig = buildMcpConfigFileContent(options);
  const serverName = Object.keys(nextConfig.mcpServers || {})[0] || SERVER_NAME;
  const launchConfig = nextConfig.mcpServers?.[serverName] || buildExternalMcpLaunchConfig(options);
  const current = readJsonObjectFileSafe(filePath);
  const existingServers =
    current?.mcpServers && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers)
      ? current.mcpServers
      : {};
  const existingEntry = existingServers[serverName];
  const { servers: prunedServers, removedLegacyServers } = pruneLegacyLiepinServers(existingServers, serverName);
  const merged = {
    ...current,
    mcpServers: {
      ...prunedServers,
      [serverName]: launchConfig
    }
  };
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
  const updated = JSON.stringify(existingEntry || null) !== JSON.stringify(launchConfig)
    || removedLegacyServers.length > 0;
  return {
    file: filePath,
    server: serverName,
    updated,
    removedLegacyServers
  };
}

function pruneLegacyLiepinServers(servers = {}, currentServerName = SERVER_NAME) {
  const pruned = { ...servers };
  const removedLegacyServers = [];
  for (const legacyName of legacyServerNames) {
    if (legacyName === currentServerName) continue;
    const entry = pruned[legacyName];
    if (!isLegacyLiepinServerEntry(entry)) continue;
    delete pruned[legacyName];
    removedLegacyServers.push(legacyName);
  }
  return {
    servers: pruned,
    removedLegacyServers
  };
}

function isLegacyLiepinServerEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const haystack = JSON.stringify({
    command: entry.command || "",
    args: Array.isArray(entry.args) ? entry.args : [],
    env: entry.env || {}
  });
  return haystack.includes(legacyLiepinPackageName);
}

function installExternalMcpConfigs(options = {}) {
  const targets = resolveExternalMcpConfigTargets(options);
  const applied = [];
  const skipped = [];
  for (const target of targets) {
    try {
      const existed = pathExists(target);
      const merged = mergeMcpServerConfigFile(target, options);
      applied.push({
        file: target,
        server: merged.server,
        created: !existed,
        updated: merged.updated,
        removedLegacyServers: merged.removedLegacyServers || []
      });
    } catch (error) {
      skipped.push({
        file: target,
        reason: error?.message || String(error)
      });
    }
  }
  return { targets, applied, skipped };
}

function getKnownExternalSkillBaseDirsByAgent() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const traeDirNames = dedupeLower([
    "Trae",
    "Trae CN",
    "TraeCN",
    "trae-cn",
    "trae_cn",
    ...discoverAppDataDirsByPattern(appData, /^trae(?:[\s\-_]?cn)?$/i)
  ]);
  const traeSkillDirs = traeDirNames.map((dir) => path.join(appData, dir, "User", "skills"));
  return {
    cursor: [path.join(home, ".cursor", "skills"), path.join(appData, "Cursor", "User", "skills")],
    trae: [path.join(home, ".trae", "skills"), path.join(home, ".trae-cn", "skills"), ...traeSkillDirs],
    "trae-cn": [path.join(home, ".trae-cn", "skills"), path.join(home, ".trae", "skills"), ...traeSkillDirs],
    claude: [path.join(home, ".claude", "skills")],
    openclaw: [path.join(home, ".openclaw", "skills"), path.join(appData, "OpenClaw", "User", "skills")]
  };
}

function resolveExternalSkillBaseDirs(options = {}) {
  const fromEnv = parsePathListFromEnv(process.env[externalSkillDirsEnv]);
  const pathMap = getKnownExternalSkillBaseDirsByAgent();
  const agents = parseAgentTargets(options.agent);
  const knownCandidates = agents.flatMap((agent) => pathMap[agent] || []);
  const known = dedupePaths(knownCandidates).filter((dirPath) => {
    if (options.agent) return true;
    return pathExists(dirPath);
  });
  return dedupePaths([...fromEnv, ...known]);
}

function syncSkillAssets(options = {}) {
  const force = options.force === true;
  const results = [];
  for (const skillName of bundledSkillNames) {
    const sourceDir = getSkillSourceDir(skillName);
    const targetDir = getSkillTargetDir(skillName);
    const skillEntry = path.join(targetDir, "SKILL.md");
    const installedVersion = readInstalledSkillVersion(skillName);
    const sourceMissing = !pathExists(path.join(sourceDir, "SKILL.md"));
    const needsSync = !sourceMissing && (force || !pathExists(skillEntry) || installedVersion !== packageVersion);
    if (needsSync) {
      ensureDirSync(path.dirname(targetDir));
      fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
      writeInstalledSkillVersion(skillName, packageVersion);
    }
    results.push({
      skill: skillName,
      sourceDir,
      targetDir,
      updated: needsSync,
      sourceMissing,
      installedVersion,
      packageVersion
    });
  }
  return {
    primaryTargetDir: results[0]?.targetDir || null,
    results
  };
}

function installSkill() {
  return syncSkillAssets({ force: true }).results;
}

function mirrorSkillToExternalDirs(options = {}) {
  const baseDirs = resolveExternalSkillBaseDirs(options);
  const mirrored = [];
  const skipped = [];
  for (const baseDir of baseDirs) {
    for (const skillName of bundledSkillNames) {
      const sourceDir = getSkillSourceDir(skillName);
      if (!pathExists(path.join(sourceDir, "SKILL.md"))) {
        skipped.push({
          base_dir: baseDir,
          skill: skillName,
          reason: `Skill source missing: ${sourceDir}`
        });
        continue;
      }
      try {
        const targetDir = path.join(baseDir, skillName);
        ensureDirSync(path.dirname(targetDir));
        fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
        mirrored.push({
          base_dir: baseDir,
          target_dir: targetDir,
          skill: skillName
        });
      } catch (error) {
        skipped.push({
          base_dir: baseDir,
          skill: skillName,
          reason: error?.message || String(error)
        });
      }
    }
  }
  return { baseDirs, mirrored, skipped };
}

export function runInstall({
  workspaceRoot,
  writeConfigTemplate = true,
  overwriteConfigTemplate = false,
  exportExternalConfig = true,
  externalConfigPath = null,
  agent = null
} = {}) {
  const layout = ensureRuntimeLayout(workspaceRoot);
  const fixes = [];
  const skillInstall = installSkill();
  const externalMcpConfigs = installExternalMcpConfigs({ agent, workspaceRoot: layout.workspaceRoot });
  const externalSkillInstall = mirrorSkillToExternalDirs({ agent });

  if (writeConfigTemplate) {
    fixes.push({
      key: "screening_config_template",
      ...writeScreeningConfigTemplate(workspaceRoot, {
        overwrite: overwriteConfigTemplate
      })
    });
  }

  const externalAgentConfig = exportExternalConfig
    ? exportExternalAgentConfig({
      workspaceRoot,
      outputPath: externalConfigPath
    })
    : null;
  const screeningConfig = getScreeningConfigResolution(workspaceRoot);

  return {
    ok: true,
    installed: true,
    runtimeLayout: layout,
    skillInstall,
    externalMcpConfigs,
    externalSkillInstall,
    screeningConfig: {
      path: screeningConfig.configPath,
      exists: screeningConfig.exists,
      valid: screeningConfig.validation.ok
    },
    fixes,
    externalAgentConfig,
    hints: {
      doctor: `node src/cli.js doctor --debug-port ${DEFAULT_DEBUG_PORT}`,
      selfHeal: "node src/cli.js self-heal",
      providerCheck: "node src/cli.js provider check --mode both",
      environment: {
        mcpTargetsEnv: externalMcpTargetsEnv,
        skillDirsEnv: externalSkillDirsEnv
      }
    }
  };
}

export async function runSelfHeal({
  workspaceRoot,
  port = DEFAULT_DEBUG_PORT,
  providerCheck = false,
  requireChatPage = false,
  targetPage = null,
  requireScreeningConfig = true,
  exportExternalConfig = true,
  externalConfigPath = null,
  agent = null
} = {}) {
  const install = runInstall({
    workspaceRoot,
    writeConfigTemplate: true,
    overwriteConfigTemplate: false,
    exportExternalConfig,
    externalConfigPath,
    agent
  });
  const doctor = await runDoctor({
    workspaceRoot,
    port,
    fix: true,
    providerCheck,
    requireChatPage,
    targetPage,
    requireScreeningConfig
  });
  return {
    ok: doctor.ok,
    install,
    doctor
  };
}

export function buildExternalAgentConfig({
  workspaceRoot,
  command = null,
  args = null,
  env = null,
  serverName = SERVER_NAME
} = {}) {
  const layout = ensureRuntimeLayout(workspaceRoot);
  const workspace = path.resolve(layout.workspaceRoot);
  const launchConfig = buildExternalMcpLaunchConfig({
    command,
    args,
    env,
    workspaceRoot: workspace,
    packageVersion
  });
  return {
    schemaVersion: EXTERNAL_AGENT_CONFIG_SCHEMA_VERSION,
    generatedAt: toIsoNow(),
    serverName: SERVER_NAME,
    workspaceRoot: workspace,
    runtimeHome: layout.stateHome,
    screeningConfigPath: layout.configPath,
    mcpServers: {
      [normalizeText(serverName) || SERVER_NAME]: launchConfig
    },
    tools: Object.values(TOOL_NAMES)
  };
}

export function exportExternalAgentConfig({
  workspaceRoot,
  outputPath = null,
  command = null,
  args = null,
  env = null,
  serverName = SERVER_NAME
} = {}) {
  const layout = ensureRuntimeLayout(workspaceRoot);
  const targetPath = resolveExternalAgentConfigPath(layout.workspaceRoot, outputPath);
  const config = buildExternalAgentConfig({
    workspaceRoot: layout.workspaceRoot,
    command,
    args,
    env,
    serverName
  });
  writeJsonFile(targetPath, config);
  return {
    ok: true,
    path: targetPath,
    schemaVersion: EXTERNAL_AGENT_CONFIG_SCHEMA_VERSION
  };
}

export function exportSkill({
  workspaceRoot,
  format = "markdown",
  outputPath = null
} = {}) {
  const normalizedFormat = normalizeSkillExportFormat(format);
  const layout = ensureRuntimeLayout(workspaceRoot);
  const payload = buildSkillExportPayload({ workspaceRoot: layout.workspaceRoot });
  const targetPath = resolveSkillExportPath(layout.workspaceRoot, normalizedFormat, outputPath);

  ensureDirSync(path.dirname(targetPath));
  if (normalizedFormat === "json") {
    writeJsonFile(targetPath, payload);
  } else {
    fs.writeFileSync(targetPath, buildSkillExportMarkdown(payload), "utf8");
  }
  return {
    ok: true,
    format: normalizedFormat,
    path: targetPath,
    schemaVersion: SKILL_EXPORT_SCHEMA_VERSION
  };
}

export function buildSkillExportPayload({
  workspaceRoot
} = {}) {
  const layout = ensureRuntimeLayout(workspaceRoot);
  const externalConfigPath = resolveExternalAgentConfigPath(layout.workspaceRoot, null);
  return {
    schemaVersion: SKILL_EXPORT_SCHEMA_VERSION,
    generatedAt: toIsoNow(),
    serverName: SERVER_NAME,
    workspaceRoot: layout.workspaceRoot,
    runtimeHome: layout.stateHome,
    screeningConfigPath: layout.configPath,
    externalAgentConfigPath: externalConfigPath,
    commands: {
      install: "node src/cli.js install",
      doctor: "node src/cli.js doctor --fix --target-page recommend --debug-port 9222",
      selfHeal: "node src/cli.js self-heal",
      providerCheck: "node src/cli.js provider check --mode both"
    },
    safety: {
      allStartCommandsDefaultToRecommendChatChain: true,
      executeRequestResumeByDefault: true,
      requireAllowChatAction: false,
      requireAllowRequestResume: false
    },
    filters: {
      mustAskUserBeforeStart: true,
      optionsTool: TOOL_NAMES.recommendFilterOptions,
      filterMeansPageConditionsNotCriteria: true,
      currentPageFilterLabel: "沿用页面当前筛选",
      example: "学历=本科、硕士; 年龄=22-30; 院校=985、211"
    },
    search: {
      mustCallOptionsBeforeStart: true,
      optionsTool: TOOL_NAMES.searchOptions,
      startTool: TOOL_NAMES.searchStart,
      requiredStartArgs: ["profile", "job", "criteria", "candidate_limit"],
      scanLimitDefault: "unset; scan until target candidates or last page",
      doctorTargetPage: "search"
    },
    chat: {
      mustCallOptionsBeforeStart: true,
      optionsTool: TOOL_NAMES.chatOptions,
      startTool: TOOL_NAMES.chatStart,
      onlyValidStartToolAfterConfirmation: TOOL_NAMES.chatStart,
      forbiddenStartTools: [TOOL_NAMES.recommendStart, TOOL_NAMES.recommendChatStart],
      requiredStartArgs: ["candidate_limit", "job", "unread_only", "criteria"],
      candidateLimitAllAliases: ["all", "全部", "所有", "扫到底", "扫完", "扫完所有人选", "扫描全部候选人", "直到列表底部"],
      candidateLimitAllMeaning: "scan until chat list bottom/platform limit; do not ask the user for a concrete integer when they gave an all-candidates expression",
      onlyPageFilterArg: "unread_only",
      doNotAskRecommendFilters: true,
      criteriaMeansAiScreeningStandard: true,
      doctorTargetPage: "chat"
    },
    doctor: {
      autoFixBeforeStart: true,
      targetPages: {
        recommend: "recommend",
        search: "search",
        chat: "chat"
      },
      manualHelpOnlyFor: ["liepin_login", "liepin_risk_page", "screening_config"]
    },
    target: {
      candidateLimitMeansPassedCandidates: true,
      scanLimitMeansMaximumScannedCandidates: true
    },
    tools: Object.values(TOOL_NAMES)
  };
}

function buildSkillExportMarkdown(payload = {}) {
  return [
    "# Liepin Recommend MCP Skill Export",
    "",
    `- Generated: ${payload.generatedAt || ""}`,
    `- Server: ${payload.serverName || ""}`,
    `- Workspace: ${payload.workspaceRoot || ""}`,
    `- Runtime Home: ${payload.runtimeHome || ""}`,
    `- Screening Config: ${payload.screeningConfigPath || ""}`,
    `- External Agent Config: ${payload.externalAgentConfigPath || ""}`,
    "",
    "## Bootstrap",
    "",
    `- Install runtime assets: \`${payload.commands?.install || "node src/cli.js install"}\``,
    `- Doctor check: \`${payload.commands?.doctor || "node src/cli.js doctor --fix --target-page recommend --debug-port 9222"}\``,
    `- Self heal: \`${payload.commands?.selfHeal || "node src/cli.js self-heal"}\``,
    `- Provider check: \`${payload.commands?.providerCheck || "node src/cli.js provider check --mode both"}\``,
    "",
    "## Safety Gates",
    "",
    "- `recommend/recommend-chat start` 默认走正式 recommend_chat_chain；`chat start` 默认走聊天页筛选。",
    "- 推荐串联默认执行真实推荐沟通点击（`allow_chat_action=true`）。",
    "- 推荐串联和聊天页筛选默认执行真实索要简历点击（`execute_request_resume=true`, `allow_request_resume=true`）。",
    "- 如需无副作用验收，请显式使用 dry-run workflow。",
    "- 启动推荐任务前先调用 `liepin_recommend_filter_options`，向用户展示可用筛选条件和选项。",
    "- `filter` 是猎聘页面筛选条件，不是 AI 筛选标准；示例：`学历=本科、硕士; 年龄=22-30; 院校=985、211`。",
    "- 启动聊天页任务前先调用 `liepin_chat_options`，只询问岗位、是否只扫未读（`unread_only`）、AI 筛选标准和目标人数；目标人数支持正整数，也支持 `all`、`全部`、`所有`、`扫到底`、`扫完所有人选` 等全量扫描表达，含义是扫到聊天列表底部/平台上限，不要再要求用户改成整数；参数确认后只能调用 `liepin_chat_start`，严禁调用 `liepin_recommend_start` 或 `liepin_recommend_chat_start`。",
    "- 启动搜索任务前先调用 `liepin_search_options`，向用户展示快捷搜索 profile 和职位选项。",
    "- 搜索任务必须确认 `profile`、`job`、`criteria`、`candidate_limit` 后再调用 `liepin_search_start`。",
    "- 搜索任务不传 `scan_limit` 时不限制扫描上限，只受目标通过人数或最后一页限制。",
    "- 启动前 doctor 传 `fix=true` 与对应 `target_page`，自动安装依赖、打开 debug Chrome、导航到目标页；只有登录/风控/配置等无法自动解决的问题才请求用户帮助。",
    "- `candidate_limit` 表示目标通过人选数，不是扫描或处理人数。",
    `- External MCP target override env: \`${externalMcpTargetsEnv}\``,
    `- External skill target override env: \`${externalSkillDirsEnv}\``,
    "",
    "## Tool Names",
    "",
    ...((payload.tools || []).map((tool) => `- \`${tool}\``))
  ].join("\n");
}

function normalizeSkillExportFormat(format) {
  const normalized = normalizeText(format).toLowerCase();
  return normalized === "json" ? "json" : "markdown";
}

function resolveSkillExportPath(workspaceRoot, format, outputPath = null) {
  if (normalizeText(outputPath)) return path.resolve(outputPath);
  const runtimeHome = ensureRuntimeLayout(workspaceRoot).stateHome;
  const extension = format === "json" ? "json" : "md";
  return path.join(runtimeHome, "exports", `liepin-skill-export.${extension}`);
}

function resolveExternalAgentConfigPath(workspaceRoot, outputPath = null) {
  if (normalizeText(outputPath)) return path.resolve(outputPath);
  const runtimeHome = ensureRuntimeLayout(workspaceRoot).stateHome;
  return path.join(runtimeHome, "external-agent-config.json");
}

export const __testables = {
  buildExternalMcpLaunchConfig,
  dedupePaths,
  installExternalMcpConfigs,
  installSkill,
  mergeMcpServerConfigFile,
  mirrorSkillToExternalDirs,
  parseAgentTargets,
  resolveExternalMcpConfigTargets,
  resolveExternalSkillBaseDirs
};
