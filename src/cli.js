import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CHAT_SAMPLE_LIMIT,
  DEFAULT_DEBUG_PORT,
  DEFAULT_RECOMMEND_SAMPLE_LIMIT,
  DEFAULT_RECOMMEND_STEP_DELAY_MS,
  DEFAULT_TARGET_SURVEY_PER_PASS,
  RUN_KINDS,
  RUN_WORKFLOWS
} from "./constants.js";
import {
  ensureRuntimeLayout,
  getWorkspaceRoot,
  readScreeningConfig,
  resolveDefaultDebugPort
} from "./config.js";
import { runDoctor } from "./doctor.js";
import { probeResumeAcquisitionMatrix } from "./liepin/acquisition-matrix.js";
import { executeChatAction, summarizeChatActionResult } from "./liepin/chat-action.js";
import {
  buildMockChatScreeningProvider,
  runChatDryRunScreening,
  summarizeChatDryRunScreening
} from "./liepin/chat-dry-run-screening.js";
import {
  executeRecommendAction,
  summarizeRecommendActionResult
} from "./liepin/recommend-action.js";
import {
  runRecommendChatChain,
  summarizeRecommendChatChain
} from "./liepin/recommend-chat-chain.js";
import {
  runSearchChatChain,
  summarizeSearchChatChain
} from "./liepin/search-chat-chain.js";
import {
  discoverSearchOptions,
  summarizeSearchOptions
} from "./liepin/search-options.js";
import {
  discoverChatOptions,
  summarizeChatOptions
} from "./liepin/chat-options.js";
import { collectChatConversationStates, sampleChatResumeDetailResumes } from "./liepin/chat-sampler.js";
import { collectChatScreenInputs } from "./liepin/chat-screen-input.js";
import {
  DEFAULT_CHAT_REST_LEVEL,
  runChatScreening,
  summarizeChatScreening
} from "./liepin/chat-screening.js";
import { summarizeChatScreeningPolicy } from "./liepin/chat-state-policy.js";
import { validateSurveyCvParsing } from "./liepin/cv-parser.js";
import { auditSurveyPayloadCoverage } from "./liepin/cv-payload.js";
import { runChromeDiscovery } from "./liepin/discovery.js";
import {
  auditChatInfiniteScroll,
  auditRecommendInfiniteScroll,
  summarizeInfiniteScrollAudit
} from "./liepin/infinite-scroll.js";
import {
  discoverRecommendFilters,
  summarizeRecommendFilterDiscovery
} from "./liepin/recommend-filter-discovery.js";
import {
  buildRecommendFilterPlan,
  executeRecommendFilters,
  summarizeRecommendFilterExecution
} from "./liepin/recommend-filter-executor.js";
import {
  buildMockRecommendScreeningProvider,
  runRecommendDryRunScreening,
  summarizeRecommendDryRunScreening
} from "./liepin/recommend-dry-run-screening.js";
import { createLineFramedServer } from "./json-rpc.js";
import { runProviderCheck } from "./provider-check.js";
import {
  exportExternalAgentConfig,
  exportSkill,
  runInstall,
  runSelfHeal
} from "./platform.js";
import {
  runRecommendTraversalAudit,
  summarizeRecommendTraversal
} from "./liepin/recommend-traversal.js";
import {
  normalizeRobustnessMode,
  parseHeartbeatIntervalMs
} from "./long-run-runtime.js";
import { runCvStructureSurvey } from "./liepin/cv-survey.js";
import { sampleRecommendDetailedResumes } from "./liepin/recommend-sampler.js";
import {
  buildRunStatusPayload,
  clearPauseRequest,
  createRunSnapshot,
  isRunTerminal,
  listRuns,
  readRunState,
  requestCancel,
  requestPause,
  summarizeRun
} from "./run-state.js";
import { isAllCandidateLimit, normalizeText, parsePositiveInteger, readJsonFile } from "./utils.js";

const currentFilePath = fileURLToPath(import.meta.url);
const workerScriptPath = path.join(path.dirname(currentFilePath), "worker.js");

export async function runCli(argv = process.argv.slice(2)) {
  const workspaceRoot = getWorkspaceRoot();
  ensureRuntimeLayout(workspaceRoot);
  const defaultDebugPort = resolveDefaultDebugPort(workspaceRoot);
  const command = argv[0];
  const subcommand = argv[1];
  const flags = parseFlags(argv.slice(2));
  const rootFlags = parseFlags(argv.slice(1));

  if (!command || command === "help" || command === "--help") {
    process.stdout.write(`${buildHelp()}\n`);
    return;
  }

  if (command === "start") {
    createLineFramedServer();
    return;
  }

  if (command === "doctor") {
    const result = await runDoctor({
      workspaceRoot,
      port: parsePositiveInteger(rootFlags.debugPort || rootFlags["debug-port"], defaultDebugPort),
      fix: Boolean(rootFlags.fix),
      providerCheck: Boolean(rootFlags["provider-check"] || rootFlags.providerCheck),
      requireChatPage: Boolean(rootFlags["require-chat-page"] || rootFlags.requireChatPage),
      targetPage: normalizeText(rootFlags["target-page"] || rootFlags.targetPage) || null,
      requireScreeningConfig: parseOptionalBoolean(
        rootFlags["require-screening-config"] || rootFlags.requireScreeningConfig,
        true
      )
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "install") {
    const result = runInstall({
      workspaceRoot,
      writeConfigTemplate: parseOptionalBoolean(
        rootFlags["write-config-template"] || rootFlags.writeConfigTemplate,
        true
      ),
      overwriteConfigTemplate: parseOptionalBoolean(
        rootFlags["overwrite-config-template"] || rootFlags.overwriteConfigTemplate,
        false
      ),
      exportExternalConfig: parseOptionalBoolean(
        rootFlags["export-external-config"] || rootFlags.exportExternalConfig,
        true
      ),
      externalConfigPath: normalizeText(
        rootFlags["external-config-path"] || rootFlags.externalConfigPath
      ) || null,
      agent: normalizeText(rootFlags.agent) || null
    });
    printJson(result);
    return;
  }

  if (command === "self-heal") {
    const result = await runSelfHeal({
      workspaceRoot,
      port: parsePositiveInteger(rootFlags.debugPort || rootFlags["debug-port"], defaultDebugPort),
      providerCheck: Boolean(rootFlags["provider-check"] || rootFlags.providerCheck),
      requireChatPage: Boolean(rootFlags["require-chat-page"] || rootFlags.requireChatPage),
      targetPage: normalizeText(rootFlags["target-page"] || rootFlags.targetPage) || null,
      requireScreeningConfig: parseOptionalBoolean(
        rootFlags["require-screening-config"] || rootFlags.requireScreeningConfig,
        true
      ),
      exportExternalConfig: parseOptionalBoolean(
        rootFlags["export-external-config"] || rootFlags.exportExternalConfig,
        true
      ),
      externalConfigPath: normalizeText(
        rootFlags["external-config-path"] || rootFlags.externalConfigPath
      ) || null,
      agent: normalizeText(rootFlags.agent) || null
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "skill" && subcommand === "export") {
    const result = exportSkill({
      workspaceRoot,
      format: normalizeText(flags.format) || "markdown",
      outputPath: normalizeText(flags.output) || null
    });
    printJson(result);
    return;
  }

  if (
    (command === "external-agent" && subcommand === "config")
    || (
      command === "external-agent-config"
      && (
        !subcommand
        || subcommand === "config"
        || String(subcommand).startsWith("--")
      )
    )
  ) {
    const result = exportExternalAgentConfig({
      workspaceRoot,
      outputPath: normalizeText(flags.output || rootFlags.output) || null
    });
    printJson(result);
    return;
  }

  if (command === "research") {
    await runResearchCommand(subcommand, flags, workspaceRoot);
    return;
  }

  if (command === "provider") {
    await runProviderCommand(subcommand, flags);
    return;
  }

  if (command === "runs") {
    await runRunCommand(subcommand, flags);
    return;
  }

  if (["recommend", "chat", "recommend-chat", "search"].includes(command) && subcommand === "start") {
    assertCliNotChatOnlyMisroute(command, flags);
    const input = parseStartInputFlags(command, flags, defaultDebugPort);
    const effectiveKind = runKindForWorkflow(command, input.workflow);
    assertCliSideEffectApproval({
      needsChatAction: input.workflow === RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN
        || input.workflow === RUN_WORKFLOWS.SEARCH_CHAT_CHAIN,
      needsRequestResume: input.workflow === RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN
        && Boolean(input.execute_request_resume)
        || input.workflow === RUN_WORKFLOWS.CHAT_SCREENING,
      allowChatAction: Boolean(input.allow_chat_action),
      allowRequestResume: Boolean(input.allow_request_resume)
    });
    const preflight = await runDoctor({
      workspaceRoot,
      port: input.debug_port,
      fix: true,
      requireChatPage: targetPageForCliStart(command, input) === "chat",
      targetPage: targetPageForCliStart(command, input),
      requireScreeningConfig: requiresScreeningConfigForCliStart(input)
    });
    if (!preflight.ok) {
      printJson({
        status: "FAILED",
        error: {
          code: "DOCTOR_FAILED",
          message: `启动前检查未通过；已自动处理可修复项，仍需人工处理剩余问题。目标页面：${preflight.targetPage}。`
        },
        doctor: preflight
      });
      process.exitCode = 1;
      return;
    }
    const snapshot = createRunSnapshot({
      workspaceRoot,
      kind: effectiveKind,
      mode: "async_workflow",
      phase: "P29",
      input
    });
    const worker = spawnWorkerProcess({
      workspaceRoot,
      runId: snapshot.run_id
    });
    printJson({
      status: "ACCEPTED",
      run_id: snapshot.run_id,
      kind: effectiveKind,
      pid: worker.pid,
      state: snapshot.state,
      workflow: input.workflow,
      robustness_mode: input.robustness_mode,
      preflight: {
        ok: true,
        targetPage: preflight.targetPage,
        fixes: preflight.fixes || []
      },
      note: "已创建异步 run；使用 runs status/list 查看进度。"
    });
    return;
  }

  throw new Error(`Unknown command: ${argv.join(" ")}`);
}

async function runProviderCommand(subcommand, flags) {
  if (subcommand === "check") {
    const result = await runProviderCheck({
      workspaceRoot: getWorkspaceRoot(),
      mode: normalizeText(flags.mode) || "both"
    });
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown provider command: ${subcommand || ""}`);
}

async function runResearchCommand(subcommand, flags, workspaceRoot = getWorkspaceRoot()) {
  const port = parsePositiveInteger(
    flags.debugPort || flags["debug-port"],
    resolveDefaultDebugPort(workspaceRoot)
  );
  if (subcommand === "discover") {
    printJson(await runChromeDiscovery({ port }));
    return;
  }
  if (subcommand === "recommend-sample") {
    const samples = await sampleRecommendDetailedResumes({ port }, {
      limit: parsePositiveInteger(flags.limit, DEFAULT_RECOMMEND_SAMPLE_LIMIT)
    });
    printJson({ ok: true, sample_count: samples.length, samples });
    return;
  }
  if (subcommand === "recommend-filter-discovery") {
    const result = await discoverRecommendFilters({ port }, {
      verify: flags.verify !== "false"
    });
    printJson({ ok: result.passed, summary: summarizeRecommendFilterDiscovery(result), result });
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (subcommand === "search-options") {
    const discovery = await discoverSearchOptions({ port }, {
      openJobDropdown: flags["open-job-dropdown"] !== "false"
    });
    printJson({ ok: discovery.passed, summary: summarizeSearchOptions(discovery), discovery });
    if (!discovery.passed) process.exitCode = 1;
    return;
  }
  if (subcommand === "chat-options") {
    const discovery = await discoverChatOptions({ port }, {
      openJobDropdown: flags["open-job-dropdown"] !== "false"
    });
    printJson({ ok: discovery.passed, summary: summarizeChatOptions(discovery), discovery });
    if (!discovery.passed) process.exitCode = 1;
    return;
  }
  if (subcommand === "recommend-filter-execute") {
    const plan = buildRecommendFilterPlan({
      preset: normalizeText(flags.preset),
      graduationYear: normalizeText(flags["graduation-year"] || flags.graduationYear),
      education: normalizeText(flags.education),
      salaryRange: normalizeText(flags["salary-range"] || flags.salaryRange),
      ageMin: normalizeText(flags["age-min"] || flags.ageMin),
      ageMax: normalizeText(flags["age-max"] || flags.ageMax),
      schoolTier: normalizeText(flags["school-tier"] || flags.schoolTier),
      jobStatus: normalizeText(flags["job-status"] || flags.jobStatus)
    });
    const result = await executeRecommendFilters({ port }, {
      plan,
      restore: flags.restore !== "false",
      clearOnly: Boolean(flags.clear)
    });
    printJson({ ok: result.passed, summary: summarizeRecommendFilterExecution(result), result });
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (subcommand === "recommend-scroll-audit") {
    const result = await auditRecommendInfiniteScroll({ port }, {
      maxPasses: parsePositiveInteger(flags["max-passes"] || flags.maxPasses, 80),
      idlePasses: parsePositiveInteger(flags["idle-passes"] || flags.idlePasses, 3),
      delayMs: parsePositiveInteger(flags["delay-ms"] || flags.delayMs, 900),
      probeDelayMs: parsePositiveInteger(flags["probe-delay-ms"] || flags.probeDelayMs, 1200),
      bottomSettleDelayMs: parsePositiveInteger(flags["bottom-settle-delay-ms"] || flags.bottomSettleDelayMs, 4000),
      terminalSignalGracePasses: parsePositiveInteger(flags["terminal-signal-grace-passes"] || flags.terminalSignalGracePasses, 3),
      terminalSignalRequired: parseOptionalBoolean(flags["terminal-signal"] || flags.terminalSignal, true),
      scrollViewportMultiplier: parsePositiveNumber(flags["scroll-pages"] || flags.scrollPages, 4)
    });
    printJson({ ok: result.passed, summary: summarizeInfiniteScrollAudit(result), result });
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (subcommand === "recommend-traversal-audit") {
    const result = await runRecommendTraversalAudit({ port }, {
      steps: parsePositiveInteger(flags.steps, 10),
      traverseTabLabel: normalizeText(flags.tab) || "推荐",
      startIndex: parseOptionalNonNegativeInteger(flags["start-index"] || flags.startIndex) || 0,
      stepDelayMs: parsePositiveInteger(flags["step-delay-ms"] || flags.stepDelayMs, DEFAULT_RECOMMEND_STEP_DELAY_MS)
    });
    printJson({ ok: result.passed, summary: summarizeRecommendTraversal(result), result });
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (subcommand === "recommend-dry-run-screening") {
    const llm = resolveRecommendDryRunLlm(flags);
    const result = await runRecommendDryRunScreening({ port }, {
      candidateLimit: parsePositiveInteger(flags["candidate-limit"] || flags.candidateLimit, 20),
      tabLabel: normalizeText(flags.tab) || "推荐",
      startIndex: parseOptionalNonNegativeInteger(flags["start-index"] || flags.startIndex) || 0,
      stepDelayMs: parsePositiveInteger(flags["step-delay-ms"] || flags.stepDelayMs, DEFAULT_RECOMMEND_STEP_DELAY_MS),
      maxPayloadChars: parsePositiveInteger(flags.maxChars || flags["max-chars"], null),
      config: llm.config,
      provider: llm.provider
    });
    printJson({ ok: result.passed, summary: summarizeRecommendDryRunScreening(result), result });
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (subcommand === "recommend-action") {
    const action = normalizeText(flags.action) || "none";
    assertCliSideEffectApproval({
      needsChatAction: action === "chat",
      allowChatAction: parseOptionalBoolean(flags["allow-chat-action"] || flags.allowChatAction, false)
    });
    const result = await executeRecommendAction({ port }, {
      action,
      tabLabel: normalizeText(flags.tab) || "推荐",
      startIndex: parseOptionalNonNegativeInteger(flags["start-index"] || flags.startIndex) || 0,
      stepDelayMs: parsePositiveInteger(flags["step-delay-ms"] || flags.stepDelayMs, DEFAULT_RECOMMEND_STEP_DELAY_MS),
      returnToRecommend: parseOptionalBoolean(flags["return-to-recommend"] || flags.returnToRecommend, true)
    });
    printJson({ ok: result.ok, summary: summarizeRecommendActionResult(result), result });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (subcommand === "recommend-chat-chain") {
    const executeRequestResume = parseOptionalBoolean(flags["execute-request-resume"] || flags.executeRequestResume, false);
    assertCliSideEffectApproval({
      needsChatAction: true,
      needsRequestResume: executeRequestResume,
      allowChatAction: parseOptionalBoolean(flags["allow-chat-action"] || flags.allowChatAction, false),
      allowRequestResume: parseOptionalBoolean(flags["allow-request-resume"] || flags.allowRequestResume, false)
    });
    const llm = resolveRecommendChatChainLlm(flags);
    const result = await runRecommendChatChain({ port }, {
      candidateLimit: parsePositiveInteger(flags["candidate-limit"] || flags.candidateLimit, 5),
      scanLimit: parsePositiveInteger(flags["scan-limit"] || flags.scanLimit, null),
      tabLabel: normalizeText(flags.tab) || "推荐",
      startIndex: parseOptionalNonNegativeInteger(flags["start-index"] || flags.startIndex) || 0,
      stepDelayMs: parsePositiveInteger(flags["step-delay-ms"] || flags.stepDelayMs, DEFAULT_RECOMMEND_STEP_DELAY_MS),
      chatEntryTimeoutMs: parsePositiveInteger(flags["chat-entry-timeout-ms"] || flags.chatEntryTimeoutMs, 30000),
      maxPayloadChars: parsePositiveInteger(flags.maxChars || flags["max-chars"], null),
      executeRequestResume,
      config: llm.config,
      recommendProvider: llm.recommendProvider,
      chatProvider: llm.chatProvider
    });
    printJson({ ok: result.passed, summary: summarizeRecommendChatChain(result), result });
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (subcommand === "search-chat-chain") {
    assertCliSideEffectApproval({
      needsChatAction: true,
      allowChatAction: parseOptionalBoolean(flags["allow-chat-action"] || flags.allowChatAction, false)
    });
    const llm = resolveSearchChatChainLlm(flags);
    const result = await runSearchChatChain({ port }, {
      candidateLimit: parsePositiveInteger(flags["candidate-limit"] || flags.candidateLimit, 5),
      scanLimit: parsePositiveInteger(flags["scan-limit"] || flags.scanLimit, null),
      profile: normalizeText(flags.profile || flags["search-profile"] || flags.searchProfile) || null,
      jobTitle: normalizeText(flags.job || flags["job-title"] || flags.jobTitle) || null,
      hideRead: parseOptionalBoolean(flags["hide-read"] ?? flags.hideRead ?? flags["hide-viewed"] ?? flags.hideViewed, false),
      startIndex: parseOptionalNonNegativeInteger(flags["start-index"] || flags.startIndex) || 0,
      stepDelayMs: parsePositiveInteger(flags["step-delay-ms"] || flags.stepDelayMs, DEFAULT_RECOMMEND_STEP_DELAY_MS),
      maxPayloadChars: parsePositiveInteger(flags.maxChars || flags["max-chars"], null),
      criteria: normalizeText(flags.criteria || flags["recommend-criteria"] || flags.recommendCriteria) || null,
      operatorFilter: normalizeFilterFlag(flags.filter),
      config: llm.config,
      provider: llm.provider
    });
    printJson({ ok: result.passed, summary: summarizeSearchChatChain(result), result });
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (subcommand === "chat-scroll-audit") {
    const result = await auditChatInfiniteScroll({ port }, {
      conversationFilterLabel: normalizeFilterFlag(flags.filter) || "有简历",
      maxPasses: parsePositiveInteger(flags["max-passes"] || flags.maxPasses, 80),
      idlePasses: parsePositiveInteger(flags["idle-passes"] || flags.idlePasses, 3),
      delayMs: parsePositiveInteger(flags["delay-ms"] || flags.delayMs, 900),
      probeDelayMs: parsePositiveInteger(flags["probe-delay-ms"] || flags.probeDelayMs, 1200),
      bottomSettleDelayMs: parsePositiveInteger(flags["bottom-settle-delay-ms"] || flags.bottomSettleDelayMs, 2500),
      terminalSignalGracePasses: parsePositiveInteger(flags["terminal-signal-grace-passes"] || flags.terminalSignalGracePasses, 2),
      terminalSignalRequired: parseOptionalBoolean(flags["terminal-signal"] || flags.terminalSignal, false),
      scrollViewportMultiplier: parsePositiveNumber(flags["scroll-pages"] || flags.scrollPages, 0.85)
    });
    printJson({ ok: result.passed, summary: summarizeInfiniteScrollAudit(result), result });
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (subcommand === "acquisition-probe") {
    const matrix = await probeResumeAcquisitionMatrix({ port });
    printJson({ ok: true, matrix });
    return;
  }
  if (subcommand === "chat-states") {
    const states = await collectChatConversationStates({ port }, {
      rowLimit: parsePositiveInteger(flags.limit, 20),
      conversationFilterLabel: normalizeFilterFlag(flags.filter)
    });
    printJson({ ok: true, row_count: states.length, states });
    return;
  }
  if (subcommand === "chat-sample") {
    const samples = await sampleChatResumeDetailResumes({ port }, {
      limit: parsePositiveInteger(flags.limit, DEFAULT_CHAT_SAMPLE_LIMIT),
      conversationFilterLabel: normalizeFilterFlag(flags.filter)
    });
    printJson({ ok: true, sample_count: samples.length, samples });
    return;
  }
  if (subcommand === "chat-screen-inputs") {
    const result = await collectChatScreenInputs({ port }, {
      limit: parsePositiveInteger(flags.limit, 10),
      rowLimit: parsePositiveInteger(flags["row-limit"] || flags.rowLimit, 40),
      conversationFilterLabel: normalizeFilterFlag(flags.filter) || "有简历"
    });
    printJson({ ok: true, result });
    return;
  }
  if (subcommand === "chat-policy-audit") {
    const states = await collectChatConversationStates({ port }, {
      rowLimit: parsePositiveInteger(flags.limit, 20),
      conversationFilterLabel: normalizeFilterFlag(flags.filter) || "有简历"
    });
    const result = summarizeChatScreeningPolicy(states);
    printJson({ ok: result.passed, row_count: states.length, result });
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (subcommand === "chat-action") {
    const action = normalizeText(flags.action);
    assertCliSideEffectApproval({
      needsRequestResume: action === "request_resume",
      allowRequestResume: parseOptionalBoolean(flags["allow-request-resume"] || flags.allowRequestResume, false)
    });
    const result = await executeChatAction({ port }, {
      action,
      rowKey: normalizeText(flags["row-key"] || flags.rowKey) || null,
      rowIndex: parseOptionalNonNegativeInteger(flags["row-index"] || flags.rowIndex),
      rowLimit: parsePositiveInteger(flags["row-limit"] || flags.rowLimit, 40),
      conversationFilterLabel: normalizeFilterFlag(flags.filter) || "有简历"
    });
    printJson({ ok: result.ok, summary: summarizeChatActionResult(result), result });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (subcommand === "chat-dry-run-screening") {
    const llm = resolveDryRunLlm(flags);
    const result = await runChatDryRunScreening({ port }, {
      candidateLimit: parsePositiveInteger(flags["candidate-limit"] || flags.candidateLimit, 20),
      rowLimit: parsePositiveInteger(flags["row-limit"] || flags.rowLimit, 40),
      maxScrollPasses: parsePositiveInteger(flags["max-scroll-passes"] || flags.maxScrollPasses, 3),
      conversationFilterLabel: normalizeFilterFlag(flags.filter) || "有简历",
      config: llm.config,
      provider: llm.provider
    });
    printJson({ ok: result.passed, summary: summarizeChatDryRunScreening(result), result });
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (subcommand === "chat-screening") {
    assertCliSideEffectApproval({
      needsRequestResume: true,
      allowRequestResume: parseOptionalBoolean(flags["allow-request-resume"] || flags.allowRequestResume, false)
    });
    const criteria = normalizeText(flags.criteria || flags["chat-criteria"] || flags.chatCriteria) || null;
    const llm = criteria
      ? resolveChatScreeningLlm(flags)
      : { config: null, provider: null };
    const result = await runChatScreening({ port }, {
      candidateLimit: requireCandidateLimitFlag(flags["candidate-limit"] || flags.candidateLimit, "--candidate-limit"),
      scanLimit: parsePositiveInteger(flags["scan-limit"] || flags.scanLimit, null),
      jobTitle: requireTextFlag(flags.job || flags["job-title"] || flags.jobTitle, "--job"),
      unreadOnly: parseRequiredBooleanFlag(flags["unread-only"] ?? flags.unreadOnly, "--unread-only"),
      criteria,
      maxPayloadChars: parsePositiveInteger(flags.maxChars || flags["max-chars"], null),
      config: llm.config,
      provider: llm.provider,
      humanBehavior: buildChatHumanBehaviorInputFromFlags(flags)
    });
    printJson({ ok: result.passed, summary: summarizeChatScreening(result), result });
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (subcommand === "cv-survey") {
    const survey = await runCvStructureSurvey({
      workspaceRoot: getWorkspaceRoot(),
      minimumSamples: parsePositiveInteger(flags.minimum, 50),
      batchSize: parsePositiveInteger(flags.batch, 10),
      perPassLimit: parsePositiveInteger(flags["per-pass"] || flags.perPass, DEFAULT_TARGET_SURVEY_PER_PASS),
      maxRounds: parsePositiveInteger(flags.rounds, 4),
      recommendSampler: async (limit) => sampleRecommendDetailedResumes({ port, tabLabel: "推荐" }, { limit }),
      latestRecommendSampler: async (limit) => sampleRecommendDetailedResumes({ port, tabLabel: "最新" }, { limit }),
      chatSampler: async (limit) => sampleChatResumeDetailResumes({ port }, {
        limit,
        conversationFilterLabel: "有简历"
      }),
      onProgress: buildSurveyProgressLogger(flags)
    });
    printJson({ ok: true, survey });
    return;
  }
  if (subcommand === "parse-survey") {
    const filePath = normalizeText(flags.file);
    if (!filePath) {
      throw new Error("--file is required");
    }
    const payload = readJsonFile(filePath, null);
    if (!payload) {
      throw new Error(`无法读取 survey 文件：${filePath}`);
    }
    printJson({ ok: true, result: validateSurveyCvParsing(payload) });
    return;
  }
  if (subcommand === "audit-payload") {
    const filePath = normalizeText(flags.file);
    if (!filePath) {
      throw new Error("--file is required");
    }
    const payload = readJsonFile(filePath, null);
    if (!payload) {
      throw new Error(`无法读取 survey 文件：${filePath}`);
    }
    printJson({
      ok: true,
      result: auditSurveyPayloadCoverage(payload, {
        sampleLimit: parsePositiveInteger(flags.limit, 10),
        maxPayloadChars: parsePositiveInteger(flags.maxChars || flags["max-chars"], null)
      })
    });
    return;
  }
  throw new Error(`Unknown research command: ${subcommand || ""}`);
}

function resolveDryRunLlm(flags) {
  if (parseOptionalBoolean(flags["mock-llm"] ?? flags.mockLlm, false)) {
    return {
      config: {
        model: normalizeText(flags["mock-model"] || flags.mockModel) || "mock-chat-dry-run"
      },
      provider: buildMockChatScreeningProvider({
        decision: normalizeText(flags["mock-decision"] || flags.mockDecision) || "fail",
        postAction: normalizeText(flags["mock-post-action"] || flags.mockPostAction) || "none",
        reasoningText: normalizeText(flags["mock-reasoning"] || flags.mockReasoning)
      })
    };
  }
  const resolution = readScreeningConfig(getWorkspaceRoot());
  if (!resolution.ok) {
    throw new Error(`${resolution.error.message} 如需无密钥验收 dry-run，请显式传入 --mock-llm。`);
  }
  return {
    config: resolution.config,
    provider: null
  };
}

function resolveChatScreeningLlm(flags) {
  if (parseOptionalBoolean(flags["mock-llm"] ?? flags.mockLlm, false)) {
    return {
      config: {
        model: normalizeText(flags["mock-model"] || flags.mockModel) || "mock-chat-screening"
      },
      provider: buildMockChatScreeningProvider({
        decision: normalizeText(
          flags["mock-chat-decision"]
          || flags.mockChatDecision
          || flags["mock-decision"]
          || flags.mockDecision
        ) || "fail",
        postAction: normalizeText(
          flags["mock-chat-post-action"]
          || flags.mockChatPostAction
          || flags["mock-post-action"]
          || flags.mockPostAction
        ) || "none",
        reasoningText: normalizeText(flags["mock-reasoning"] || flags.mockReasoning)
      })
    };
  }
  const resolution = readScreeningConfig(getWorkspaceRoot());
  if (!resolution.ok) {
    throw new Error(`${resolution.error.message} 如需无密钥验收 chat screening，请显式传入 --mock-llm。`);
  }
  return {
    config: resolution.config,
    provider: null
  };
}

function resolveRecommendDryRunLlm(flags) {
  if (parseOptionalBoolean(flags["mock-llm"] ?? flags.mockLlm, false)) {
    return {
      config: {
        model: normalizeText(flags["mock-model"] || flags.mockModel) || "mock-recommend-dry-run"
      },
      provider: buildMockRecommendScreeningProvider({
        decision: normalizeText(flags["mock-decision"] || flags.mockDecision) || "fail",
        postAction: normalizeText(flags["mock-post-action"] || flags.mockPostAction) || "none",
        reasoningText: normalizeText(flags["mock-reasoning"] || flags.mockReasoning)
      })
    };
  }
  const resolution = readScreeningConfig(getWorkspaceRoot());
  if (!resolution.ok) {
    throw new Error(`${resolution.error.message} 如需无密钥验收 dry-run，请显式传入 --mock-llm。`);
  }
  return {
    config: resolution.config,
    provider: null
  };
}

function resolveRecommendChatChainLlm(flags) {
  if (parseOptionalBoolean(flags["mock-llm"] ?? flags.mockLlm, false)) {
    return {
      config: {
        model: normalizeText(flags["mock-model"] || flags.mockModel) || "mock-recommend-chat-chain"
      },
      recommendProvider: buildMockRecommendScreeningProvider({
        decision: normalizeText(
          flags["mock-recommend-decision"]
          || flags.mockRecommendDecision
          || flags["mock-decision"]
          || flags.mockDecision
        ) || "pass",
        postAction: normalizeText(
          flags["mock-recommend-post-action"]
          || flags.mockRecommendPostAction
          || flags["mock-post-action"]
          || flags.mockPostAction
        ) || "chat",
        reasoningText: normalizeText(flags["mock-reasoning"] || flags.mockReasoning)
      }),
      chatProvider: buildMockChatScreeningProvider({
        decision: normalizeText(
          flags["mock-chat-decision"]
          || flags.mockChatDecision
          || flags["mock-decision"]
          || flags.mockDecision
        ) || "pass",
        postAction: normalizeText(
          flags["mock-chat-post-action"]
          || flags.mockChatPostAction
        ) || "request_resume",
        reasoningText: normalizeText(flags["mock-reasoning"] || flags.mockReasoning)
      })
    };
  }
  const resolution = readScreeningConfig(getWorkspaceRoot());
  if (!resolution.ok) {
    throw new Error(`${resolution.error.message} 如需无密钥验收 P22 串联，请显式传入 --mock-llm。`);
  }
  return {
    config: resolution.config,
    recommendProvider: null,
    chatProvider: null
  };
}

function resolveSearchChatChainLlm(flags) {
  if (parseOptionalBoolean(flags["mock-llm"] ?? flags.mockLlm, false)) {
    return {
      config: {
        model: normalizeText(flags["mock-model"] || flags.mockModel) || "mock-search-chat-chain"
      },
      provider: buildMockRecommendScreeningProvider({
        decision: normalizeText(
          flags["mock-recommend-decision"]
          || flags.mockRecommendDecision
          || flags["mock-decision"]
          || flags.mockDecision
        ) || "pass",
        postAction: normalizeText(
          flags["mock-recommend-post-action"]
          || flags.mockRecommendPostAction
          || flags["mock-post-action"]
          || flags.mockPostAction
        ) || "chat",
        reasoningText: normalizeText(flags["mock-reasoning"] || flags.mockReasoning)
      })
    };
  }
  const resolution = readScreeningConfig(getWorkspaceRoot());
  if (!resolution.ok) {
    throw new Error(`${resolution.error.message} 如需无密钥验收搜索串联，请显式传入 --mock-llm。`);
  }
  return {
    config: resolution.config,
    provider: null
  };
}

async function runRunCommand(subcommand, flags) {
  const workspaceRoot = getWorkspaceRoot();
  const runId = normalizeText(flags.runId || flags["run-id"]);
  if (subcommand === "list") {
    const full = Boolean(flags.full);
    printJson({ runs: listRuns(workspaceRoot).map((run) => (full ? run : summarizeRun(run))) });
    return;
  }
  if (subcommand === "progress") {
    const full = Boolean(flags.full);
    const kind = normalizeText(flags.kind);
    const includeCompleted = parseOptionalBoolean(flags["include-completed"] || flags.includeCompleted, true);
    const limit = parsePositiveInteger(flags.limit, 5);
    const allRuns = listRuns(workspaceRoot)
      .filter((run) => !kind || run.kind === kind);
    const activeRuns = allRuns.filter((run) => !isRunTerminal(run));
    const runs = (includeCompleted ? allRuns : activeRuns)
      .slice(0, limit)
      .map((run) => (full ? run : buildRunStatusPayload(run)));
    printJson({
      status: "RUN_PROGRESS",
      query: {
        kind: kind || null,
        include_completed: includeCompleted,
        limit
      },
      active_count: activeRuns.length,
      total_count: allRuns.length,
      latest_run: runs[0] || null,
      runs
    });
    return;
  }
  if (!runId) {
    throw new Error("--run-id is required");
  }
  if (subcommand === "status") {
    const run = readRunState(workspaceRoot, runId);
    printJson({ run: buildRunStatusPayload(run, { full: Boolean(flags.full) }) });
    if (!run) process.exitCode = 1;
    return;
  }
  if (subcommand === "pause") {
    const run = requestPause(workspaceRoot, runId);
    printJson({ run });
    if (!run) process.exitCode = 1;
    return;
  }
  if (subcommand === "cancel") {
    const run = requestCancel(workspaceRoot, runId);
    printJson({ run });
    if (!run) process.exitCode = 1;
    return;
  }
  if (subcommand === "resume") {
    const current = readRunState(workspaceRoot, runId);
    if (current && isRunTerminal(current)) {
      printJson({
        run: current,
        error: {
          code: "RUN_TERMINAL",
          message: `run_id=${runId} 已结束，不能 resume。`
        }
      });
      process.exitCode = 1;
      return;
    }
    const run = clearPauseRequest(workspaceRoot, runId);
    const worker = run
      ? spawnWorkerProcess({ workspaceRoot, runId })
      : null;
    printJson({
      run,
      pid: worker?.pid || null,
      note: "run resume 已重新进入后台 worker。"
    });
    if (!run) {
      process.exitCode = 1;
      return;
    }
    return;
  }
  throw new Error(`Unknown runs subcommand: ${subcommand || ""}`);
}

function parseFlags(argv) {
  const flags = {};
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      index += 1;
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      index += 1;
      continue;
    }
    flags[key] = next;
    index += 2;
  }
  return flags;
}

function parseStartInputFlags(kind, flags, defaultDebugPort = DEFAULT_DEBUG_PORT) {
  const base = {
    debug_port: parsePositiveInteger(flags.debugPort || flags["debug-port"], defaultDebugPort),
    sample_limit: parsePositiveInteger(flags.limit || flags.sampleLimit, DEFAULT_RECOMMEND_SAMPLE_LIMIT),
    candidate_limit: parsePositiveInteger(flags["candidate-limit"] || flags.candidateLimit, null),
    tab: normalizeText(flags.tab) || "推荐",
    filter: normalizeFilterFlag(flags.filter),
    criteria: normalizeText(flags.criteria) || null,
    recommend_criteria: normalizeText(flags["recommend-criteria"] || flags.recommendCriteria) || null,
    chat_criteria: normalizeText(flags["chat-criteria"] || flags.chatCriteria) || null,
    start_index: parseOptionalNonNegativeInteger(flags["start-index"] || flags.startIndex) || 0,
    step_delay_ms: parsePositiveInteger(flags["step-delay-ms"] || flags.stepDelayMs, DEFAULT_RECOMMEND_STEP_DELAY_MS),
    max_chars: parsePositiveInteger(flags.maxChars || flags["max-chars"], null),
    mock_llm: parseOptionalBoolean(flags["mock-llm"] ?? flags.mockLlm, false),
    mock_model: normalizeText(flags["mock-model"] || flags.mockModel),
    mock_decision: normalizeText(flags["mock-decision"] || flags.mockDecision),
    mock_post_action: normalizeText(flags["mock-post-action"] || flags.mockPostAction),
    mock_reasoning: normalizeText(flags["mock-reasoning"] || flags.mockReasoning),
    allow_chat_action: parseOptionalBoolean(flags["allow-chat-action"] || flags.allowChatAction, false),
    allow_request_resume: parseOptionalBoolean(flags["allow-request-resume"] || flags.allowRequestResume, false),
    human_behavior: buildChatHumanBehaviorInputFromFlags(flags),
    robustness_mode: normalizeRobustnessMode(
      flags["robustness-mode"] || flags.robustnessMode || flags.robustness_mode
    ),
    heartbeat_interval_ms: parseHeartbeatIntervalMs(
      flags["heartbeat-interval-ms"] || flags.heartbeatIntervalMs || flags.heartbeat_interval_ms
    )
  };

  const requestedWorkflow = normalizeText(flags.workflow) || (kind === RUN_KINDS.CHAT ? RUN_WORKFLOWS.CHAT_SCREENING : null);
  if (requestedWorkflow === RUN_WORKFLOWS.CHAT_SCREENING) {
    return buildChatScreeningStartInputFlags(base, flags);
  }

  if (kind === RUN_KINDS.RECOMMEND) {
    return {
      ...base,
      workflow: normalizeText(flags.workflow) || RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
      candidate_limit: base.candidate_limit || 20,
      scan_limit: parsePositiveInteger(flags["scan-limit"] || flags.scanLimit, null),
      chat_entry_timeout_ms: parsePositiveInteger(flags["chat-entry-timeout-ms"] || flags.chatEntryTimeoutMs, 30000),
      filter: base.filter || null,
      recommend_criteria: base.recommend_criteria || base.criteria || null,
      chat_criteria: base.chat_criteria || base.criteria || null,
      execute_request_resume: parseOptionalBoolean(flags["execute-request-resume"] || flags.executeRequestResume, true),
      allow_chat_action: parseOptionalBoolean(flags["allow-chat-action"] || flags.allowChatAction, true),
      allow_request_resume: parseOptionalBoolean(flags["allow-request-resume"] || flags.allowRequestResume, true),
      mock_decision: base.mock_decision || "fail",
      mock_post_action: base.mock_post_action || "none"
    };
  }

  if (kind === RUN_KINDS.CHAT) {
    const workflow = normalizeText(flags.workflow) || RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN;
    return {
      ...base,
      workflow,
      candidate_limit: base.candidate_limit || 20,
      scan_limit: parsePositiveInteger(flags["scan-limit"] || flags.scanLimit, null),
      chat_entry_timeout_ms: parsePositiveInteger(flags["chat-entry-timeout-ms"] || flags.chatEntryTimeoutMs, 30000),
      row_limit: parsePositiveInteger(flags["row-limit"] || flags.rowLimit, 40),
      max_scroll_passes: parsePositiveInteger(flags["max-scroll-passes"] || flags.maxScrollPasses, 3),
      filter: base.filter || null,
      recommend_criteria: base.recommend_criteria || base.criteria || null,
      chat_criteria: base.chat_criteria || base.criteria || null,
      execute_request_resume: parseOptionalBoolean(flags["execute-request-resume"] || flags.executeRequestResume, true),
      allow_chat_action: parseOptionalBoolean(flags["allow-chat-action"] || flags.allowChatAction, true),
      allow_request_resume: parseOptionalBoolean(flags["allow-request-resume"] || flags.allowRequestResume, true),
      mock_decision: base.mock_decision || "fail",
      mock_post_action: base.mock_post_action || "none"
    };
  }

  if (kind === RUN_KINDS.SEARCH) {
    return {
      ...base,
      workflow: normalizeText(flags.workflow) || RUN_WORKFLOWS.SEARCH_CHAT_CHAIN,
      profile: normalizeText(flags.profile || flags["search-profile"] || flags.searchProfile) || null,
      job: normalizeText(flags.job || flags["job-title"] || flags.jobTitle) || null,
      hide_read: parseRequiredBooleanFlag(flags["hide-read"] ?? flags.hideRead ?? flags["hide-viewed"] ?? flags.hideViewed, "--hide-read"),
      candidate_limit: base.candidate_limit || 5,
      scan_limit: parsePositiveInteger(flags["scan-limit"] || flags.scanLimit, null),
      start_index: parseOptionalNonNegativeInteger(flags["start-index"] || flags.startIndex) || 0,
      step_delay_ms: parsePositiveInteger(flags["step-delay-ms"] || flags.stepDelayMs, DEFAULT_RECOMMEND_STEP_DELAY_MS),
      filter: base.filter || null,
      criteria: base.criteria || base.recommend_criteria || null,
      execute_request_resume: false,
      allow_chat_action: parseOptionalBoolean(flags["allow-chat-action"] || flags.allowChatAction, true),
      allow_request_resume: false,
      mock_decision: base.mock_decision || "pass",
      mock_post_action: base.mock_post_action || "chat",
      mock_recommend_decision: normalizeText(flags["mock-recommend-decision"] || flags.mockRecommendDecision),
      mock_recommend_post_action: normalizeText(flags["mock-recommend-post-action"] || flags.mockRecommendPostAction)
    };
  }

  return {
    ...base,
    workflow: normalizeText(flags.workflow) || RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN,
    candidate_limit: base.candidate_limit || 5,
    scan_limit: parsePositiveInteger(flags["scan-limit"] || flags.scanLimit, null),
    chat_entry_timeout_ms: parsePositiveInteger(flags["chat-entry-timeout-ms"] || flags.chatEntryTimeoutMs, 30000),
    filter: base.filter || null,
    recommend_criteria: base.recommend_criteria || base.criteria || null,
    chat_criteria: base.chat_criteria || base.criteria || null,
    execute_request_resume: parseOptionalBoolean(flags["execute-request-resume"] || flags.executeRequestResume, true),
    allow_chat_action: parseOptionalBoolean(flags["allow-chat-action"] || flags.allowChatAction, true),
    allow_request_resume: parseOptionalBoolean(flags["allow-request-resume"] || flags.allowRequestResume, true),
    mock_recommend_decision: normalizeText(flags["mock-recommend-decision"] || flags.mockRecommendDecision),
    mock_recommend_post_action: normalizeText(flags["mock-recommend-post-action"] || flags.mockRecommendPostAction),
    mock_chat_decision: normalizeText(flags["mock-chat-decision"] || flags.mockChatDecision),
    mock_chat_post_action: normalizeText(flags["mock-chat-post-action"] || flags.mockChatPostAction)
  };
}

function buildChatScreeningStartInputFlags(base, flags) {
  return {
    ...base,
    workflow: RUN_WORKFLOWS.CHAT_SCREENING,
    candidate_limit: requireCandidateLimitFlag(flags["candidate-limit"] || flags.candidateLimit, "--candidate-limit"),
    scan_limit: parsePositiveInteger(flags["scan-limit"] || flags.scanLimit, null),
    job: requireTextFlag(flags.job || flags["job-title"] || flags.jobTitle, "--job"),
    unread_only: parseRequiredBooleanFlag(flags["unread-only"] ?? flags.unreadOnly, "--unread-only"),
    criteria: normalizeText(flags.criteria || flags["chat-criteria"] || flags.chatCriteria) || null,
    execute_request_resume: true,
    allow_chat_action: false,
    allow_request_resume: parseOptionalBoolean(flags["allow-request-resume"] || flags.allowRequestResume, true),
    human_behavior: buildChatHumanBehaviorInputFromFlags(flags),
    mock_decision: base.mock_decision || "fail",
    mock_post_action: base.mock_post_action || "none",
    mock_chat_decision: normalizeText(flags["mock-chat-decision"] || flags.mockChatDecision || base.mock_decision) || "fail",
    mock_chat_post_action: normalizeText(flags["mock-chat-post-action"] || flags.mockChatPostAction || base.mock_post_action) || "none"
  };
}

function buildChatHumanBehaviorInputFromFlags(flags = {}) {
  const restLevel = normalizeText(
    flags["rest-level"]
    || flags.restLevel
    || flags.rest_level
    || flags["human-behavior-rest-level"]
    || flags.humanBehaviorRestLevel
    || flags.human_behavior_rest_level
  ) || normalizeText(process.env.SOURCING_LIEPIN_CHAT_REST_LEVEL)
    || normalizeText(process.env.SOURCING_BOSS_CHAT_REST_LEVEL)
    || DEFAULT_CHAT_REST_LEVEL;
  const enabled = parseOptionalBoolean(
    flags["human-behavior-enabled"]
    ?? flags.humanBehaviorEnabled
    ?? flags.human_behavior_enabled,
    null
  );
  return {
    restLevel,
    ...(enabled === null ? {} : { enabled })
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function normalizeFilterFlag(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function parseOptionalNonNegativeInteger(value) {
  if (value === undefined || value === null || value === true) return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseOptionalBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (value === true) return true;
  const normalized = normalizeText(value).toLowerCase();
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  return fallback;
}

function parseRequiredBooleanFlag(value, flagName) {
  if (value === true) return true;
  if (value === false) return false;
  if (value === undefined || value === null) {
    throw new Error(`${flagName} is required and must be true|false.`);
  }
  const normalized = normalizeText(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${flagName} must be true|false.`);
}

function requireCandidateLimitFlag(value, flagName) {
  if (value === undefined || value === null || value === true) {
    throw new Error(`${flagName} is required and must be a positive integer or all.`);
  }
  if (isAllCandidateLimit(value)) return null;
  const parsed = parsePositiveInteger(value, null);
  if (!parsed) {
    throw new Error(`${flagName} is required and must be a positive integer or all.`);
  }
  return parsed;
}

function requireTextFlag(value, flagName) {
  const text = normalizeText(value);
  if (!text) {
    throw new Error(`${flagName} is required.`);
  }
  return text;
}

function parsePositiveNumber(value, fallback = null) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function assertCliSideEffectApproval({
  needsChatAction = false,
  needsRequestResume = false,
  allowChatAction = false,
  allowRequestResume = false
} = {}) {
  if (needsChatAction && !allowChatAction) {
    throw new Error("该命令会真实点击沟通；请显式传入 --allow-chat-action。");
  }
  if (needsRequestResume && !allowRequestResume) {
    throw new Error("该命令会真实索要简历；请显式传入 --allow-request-resume。");
  }
}

function assertCliNotChatOnlyMisroute(command, flags = {}) {
  if (command !== "recommend" && command !== "recommend-chat") return;
  const workflow = normalizeText(flags.workflow);
  const hasUnreadOnly = Object.hasOwn(flags, "unread-only") || Object.hasOwn(flags, "unreadOnly");
  const hasChatWorkflow = workflow === RUN_WORKFLOWS.CHAT_SCREENING
    || workflow === RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING
    || workflow === RUN_WORKFLOWS.CHAT_SAMPLE;
  if (!hasUnreadOnly && !hasChatWorkflow) return;
  throw new Error(
    "检测到 chat-only 参数被提交到了推荐页命令。聊天页任务必须使用 `chat start --candidate-limit <n> --job <岗位> --unread-only true|false [--criteria <条件>]`；criteria 留空时进入 collect-CV 模式。"
  );
}

function buildSurveyProgressLogger(flags) {
  if (flags.progress === "false" || flags["no-progress"]) return null;
  return (event) => {
    const parts = [
      `[cv-survey] ${event.phase || event.status}`,
      `samples=${event.sampledCount}`,
      `structures=${event.uniqueStructureCount}`,
      `minimum=${event.meetsMinimumSamples ? "met" : "pending"}`,
      `stable=${event.stableAfterFinalBatch ? "yes" : "no"}`,
      `stop=${event.stopReason}`,
      `file=${event.outputPath}`
    ];
    process.stderr.write(`${parts.join(" ")}\n`);
  };
}

function buildHelp() {
  return [
    "liepin-mcp commands",
    "",
    "  start",
    "  doctor [--debug-port 9222] [--fix] [--provider-check] [--require-chat-page] [--target-page recommend|search|chat]",
    "  install [--agent trae-cn|openclaw|cursor|trae|claude|all] [--write-config-template true|false] [--overwrite-config-template] [--export-external-config true|false] [--external-config-path <path>]",
    "  self-heal [--agent trae-cn|openclaw|cursor|trae|claude|all] [--debug-port 9222] [--provider-check] [--require-chat-page] [--target-page recommend|search|chat] [--export-external-config true|false] [--external-config-path <path>]",
    "  skill export [--format markdown|json] [--output <path>]",
    "  external-agent config [--output <path>]",
    "  external-agent-config [--output <path>]",
    "  provider check [--mode both|recommend|chat]",
    "  recommend start [--debug-port 9222] [--candidate-limit 20] [--scan-limit 20] [--tab 推荐] [--filter 沿用页面当前筛选] [--recommend-criteria \"推荐筛选条件\"] [--chat-criteria \"聊天筛选条件\"] [--mock-llm] [--allow-chat-action true|false] [--execute-request-resume true|false] [--allow-request-resume true|false] [--robustness-mode off|observe|recover; default recover]",
    "  search start [--debug-port 9222] --profile <搜索profile> --job <岗位> --hide-read true|false [--candidate-limit 5] [--scan-limit 20] [--criteria \"筛选条件\"] [--mock-llm] [--allow-chat-action true|false] [--robustness-mode off|observe|recover; default recover]",
    "  chat start [--debug-port 9222] --candidate-limit <n|all|全部|所有|扫到底> --job <岗位> --unread-only true|false [--criteria \"筛选条件\"; omitted = collect CV] [--scan-limit 20] [--max-chars 12000] [--rest-level low|medium|high; default high] [--mock-llm] [--allow-request-resume true|false] [--robustness-mode off|observe|recover; default recover]",
    "  recommend-chat start [--debug-port 9222] [--candidate-limit 5] [--scan-limit 10] [--filter 沿用页面当前筛选] [--recommend-criteria \"推荐筛选条件\"] [--chat-criteria \"聊天筛选条件\"] [--mock-llm] [--allow-chat-action true|false] [--execute-request-resume true|false] [--allow-request-resume true|false] [--robustness-mode off|observe|recover; default recover]",
    "  runs list [--full]",
    "  runs progress [--kind recommend|search|chat|recommend-chat] [--include-completed true|false] [--limit 5] [--full]",
    "  runs status --run-id <id> [--full]",
    "  runs pause --run-id <id>",
    "  runs resume --run-id <id>",
    "  runs cancel --run-id <id>",
    "",
    "Research helpers",
    "",
    "  research discover --debug-port 9222",
    "  research acquisition-probe --debug-port 9222",
    "  research recommend-sample --limit 5",
    "  research recommend-filter-discovery --debug-port 9222",
    "  research search-options --debug-port 9222",
    "  research chat-options --debug-port 9222",
    "  research recommend-filter-execute --preset p17 [--restore false]",
    "  research recommend-scroll-audit [--max-passes 80] [--idle-passes 3] [--scroll-pages 4] [--bottom-settle-delay-ms 4000]",
    "  research recommend-traversal-audit [--steps 10] [--tab 推荐] [--step-delay-ms 3500]",
    "  research recommend-dry-run-screening [--candidate-limit 20] [--tab 推荐] [--mock-llm]",
    "  research recommend-action --action none|chat [--start-index 0] [--tab 推荐] [--allow-chat-action]",
    "  research recommend-chat-chain [--candidate-limit 5] [--scan-limit 10] [--chat-entry-timeout-ms 30000] [--mock-llm] [--allow-chat-action true|false] [--execute-request-resume true|false] [--allow-request-resume true|false]",
    "  research search-chat-chain --profile <搜索profile> --job <岗位> [--hide-read true|false] [--candidate-limit 5] [--scan-limit 20] [--criteria \"筛选条件\"] [--mock-llm] [--allow-chat-action true|false]",
    "  research chat-scroll-audit [--filter 有简历] [--max-passes 80] [--idle-passes 3]",
    "  research chat-states --limit 20 [--filter 有简历]",
    "  research chat-sample --limit 5 [--filter 有简历]",
    "  research chat-screen-inputs --limit 10 [--filter 有简历]",
    "  research chat-policy-audit --limit 20 [--filter 有简历]",
    "  research chat-action --action none|request_resume [--row-key <key>] [--row-index <n>] [--allow-request-resume]",
    "  research chat-screening --candidate-limit <n|all|全部|所有|扫到底> --job <岗位> --unread-only true|false [--criteria \"筛选条件\"; omitted = collect CV] [--scan-limit 20] [--mock-llm] --allow-request-resume",
    "  research cv-survey --minimum 50 --batch 10 [--per-pass 10] [--rounds 4] [--no-progress]",
    "  research parse-survey --file <cv-structure-survey.json>",
    "  research audit-payload --file <cv-structure-survey.json> [--limit 10]"
  ].join("\n");
}

function targetPageForCliStart(kind, input = {}) {
  if (kind === RUN_KINDS.SEARCH || input.workflow === RUN_WORKFLOWS.SEARCH_CHAT_CHAIN) return "search";
  if (
    kind === RUN_KINDS.CHAT
    || input.workflow === RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING
    || input.workflow === RUN_WORKFLOWS.CHAT_SCREENING
    || input.workflow === RUN_WORKFLOWS.CHAT_SAMPLE
  ) {
    return "chat";
  }
  return "recommend";
}

function requiresScreeningConfigForCliStart(input = {}) {
  if (input.mock_llm) return false;
  if (input.workflow === RUN_WORKFLOWS.CHAT_SCREENING && !normalizeText(input.criteria)) {
    return false;
  }
  return true;
}

function runKindForWorkflow(kind, workflow) {
  if (
    workflow === RUN_WORKFLOWS.CHAT_SCREENING
    || workflow === RUN_WORKFLOWS.CHAT_DRY_RUN_SCREENING
    || workflow === RUN_WORKFLOWS.CHAT_SAMPLE
  ) {
    return RUN_KINDS.CHAT;
  }
  if (workflow === RUN_WORKFLOWS.SEARCH_CHAT_CHAIN) {
    return RUN_KINDS.SEARCH;
  }
  if (workflow === RUN_WORKFLOWS.RECOMMEND_CHAT_CHAIN) {
    return kind === RUN_KINDS.RECOMMEND_CHAT ? RUN_KINDS.RECOMMEND_CHAT : RUN_KINDS.RECOMMEND;
  }
  return kind;
}

function spawnWorkerProcess({ workspaceRoot, runId }) {
  const child = spawn(
    process.execPath,
    [
      workerScriptPath,
      "--run-id",
      runId,
      "--workspace-root",
      workspaceRoot
    ],
    {
      cwd: workspaceRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  child.unref();
  return child;
}

if (process.argv[1] && currentFilePath === process.argv[1]) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
