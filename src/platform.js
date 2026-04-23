import fs from "node:fs";
import path from "node:path";
import process from "node:process";

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

export function runInstall({
  workspaceRoot,
  writeConfigTemplate = true,
  overwriteConfigTemplate = false,
  exportExternalConfig = true,
  externalConfigPath = null
} = {}) {
  const layout = ensureRuntimeLayout(workspaceRoot);
  const fixes = [];

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
      providerCheck: "node src/cli.js provider check --mode both"
    }
  };
}

export async function runSelfHeal({
  workspaceRoot,
  port = DEFAULT_DEBUG_PORT,
  providerCheck = false,
  exportExternalConfig = true,
  externalConfigPath = null
} = {}) {
  const install = runInstall({
    workspaceRoot,
    writeConfigTemplate: true,
    overwriteConfigTemplate: false,
    exportExternalConfig,
    externalConfigPath
  });
  const doctor = await runDoctor({
    workspaceRoot,
    port,
    fix: true,
    providerCheck
  });
  return {
    ok: doctor.ok,
    install,
    doctor
  };
}

export function buildExternalAgentConfig({
  workspaceRoot
} = {}) {
  const layout = ensureRuntimeLayout(workspaceRoot);
  const workspace = path.resolve(layout.workspaceRoot);
  const serverScriptPath = path.join(workspace, "src", "index.js");
  const serverCommand = process.execPath;
  return {
    schemaVersion: EXTERNAL_AGENT_CONFIG_SCHEMA_VERSION,
    generatedAt: toIsoNow(),
    serverName: SERVER_NAME,
    workspaceRoot: workspace,
    runtimeHome: layout.stateHome,
    screeningConfigPath: layout.configPath,
    mcpServers: {
      [SERVER_NAME]: {
        command: serverCommand,
        args: [serverScriptPath],
        cwd: workspace,
        env: {
          LIEPIN_WORKSPACE_ROOT: workspace
        }
      }
    },
    tools: Object.values(TOOL_NAMES)
  };
}

export function exportExternalAgentConfig({
  workspaceRoot,
  outputPath = null
} = {}) {
  const layout = ensureRuntimeLayout(workspaceRoot);
  const targetPath = resolveExternalAgentConfigPath(layout.workspaceRoot, outputPath);
  const config = buildExternalAgentConfig({
    workspaceRoot: layout.workspaceRoot
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
      doctor: "node src/cli.js doctor --debug-port 9222",
      selfHeal: "node src/cli.js self-heal",
      providerCheck: "node src/cli.js provider check --mode both"
    },
    safety: {
      requireAllowChatAction: true,
      requireAllowRequestResume: true
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
    `- Doctor check: \`${payload.commands?.doctor || "node src/cli.js doctor --debug-port 9222"}\``,
    `- Self heal: \`${payload.commands?.selfHeal || "node src/cli.js self-heal"}\``,
    `- Provider check: \`${payload.commands?.providerCheck || "node src/cli.js provider check --mode both"}\``,
    "",
    "## Safety Gates",
    "",
    "- Real recommend chat click requires `--allow-chat-action` / `allow_chat_action=true`.",
    "- Real request-resume click requires `--allow-request-resume` / `allow_request_resume=true`.",
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
