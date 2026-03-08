#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { ExecutionEnvironment, ProviderName, RalphConfig, RalphRunSummary, ScheduleMode, WorkspaceStrategy } from './core/types.js';
import {
  buildPlansFromPrds,
  createPrdDraftFromBrief,
  parsePerPrdIterations,
  resolvePrdFiles,
  resolvePlanStatePaths,
  runRalphi,
  scanPrdDirectory
} from './core/runtime.js';
import { findDevcontainerConfig } from './core/devcontainer.js';
import { doctorSummaryLine, runDoctor } from './core/doctor.js';
import { failureCategoryLabel } from './core/failure.js';
import { cleanupManagedWorktrees, inspectManagedWorktrees, inspectGitWorkspace } from './core/git.js';
import { buildPromptBundle } from './core/prompt.js';
import { buildExecutionSkills, loadProjectConfig, migrateLegacyProjectRuntime, projectConfigPath, projectRalphiDir } from './core/project.js';
import { loadContextCheckpoint, clearRunState, listCheckpointSnapshots, loadPendingRunSession, saveRunSession } from './core/session.js';
import { buildSkillRegistrySnapshot } from './core/skills.js';
import { displayPath, ensureDir, findProjectRoot, normalizeSchedule, normalizeWorkspaceStrategy } from './core/utils.js';
import { buildCompactUsageSummary, buildUsageDisplayRows } from './core/usage.js';
import { runDashboard } from './ui/dashboard.js';
import { enterFullscreenTerminal } from './ui/terminal.js';
import { runWizard } from './ui/wizard.js';

export interface ParsedArgs {
  command: 'run' | 'doctor' | 'worktree-doctor' | 'worktree-cleanup' | 'prompt-preview';
  help: boolean;
  wizard: boolean;
  verbose: boolean;
  dryRun: boolean;
  tool?: ProviderName;
  schedule?: ScheduleMode;
  workspaceStrategy?: WorkspaceStrategy;
  executionEnvironment?: ExecutionEnvironment;
  maxIterations?: number;
  perPrdIterations: number[];
  prdInput?: string;
  createPrdPrompt?: string;
}

export function usage(): string {
  return `Ralphi

Usage:
  ralphi
  ralphi doctor
  ralphi worktree doctor
  ralphi worktree cleanup --dry-run
  ralphi prompt preview --prds file1
  ralphi --wizard
  ralphi --prds file1,file2 [options]
  ralphi file1,file2 [options]

Legacy local wrapper:
  ./ralph/ralphi.sh --wizard

Options:
  --tool amp|claude|codex|copilot|cursor|gemini|opencode|qwen
                                  Provider to launch. Default: amp
  --prds file1,file2              Comma-separated PRD list
  --create-prd "brief"            Start from a new feature brief
  --max-iterations N              Default PRD pass budget. Default: 10
  --per-prd-iterations 5,3,2      Explicit PRD pass budget per selected PRD
  --schedule round-robin|per-prd|parallel
                                  Multi-PRD scheduling mode. Default: round-robin
  --workspace worktree|shared     Workspace strategy. Default: worktree
  --environment local|devcontainer
                                  Run providers directly or inside a dev container
  --dry-run                       Preview a destructive command without changing state
  --verbose                       Show the raw provider feed in the dashboard
  --wizard                        Force the interactive wizard
  -h, --help                      Show this help
`;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let command: ParsedArgs['command'] = 'run';
  let cursor = 0;

  if (argv[0] === 'doctor') {
    command = 'doctor';
    cursor = 1;
  } else if (argv[0] === 'worktree' && argv[1] === 'doctor') {
    command = 'worktree-doctor';
    cursor = 2;
  } else if (argv[0] === 'worktree' && argv[1] === 'cleanup') {
    command = 'worktree-cleanup';
    cursor = 2;
  } else if (argv[0] === 'prompt' && argv[1] === 'preview') {
    command = 'prompt-preview';
    cursor = 2;
  }

  let tool: ProviderName | undefined;
  let verbose = false;
  let wizard = false;
  let dryRun = false;
  let prdInput: string | undefined;
  let maxIterations: number | undefined;
  let schedule: ScheduleMode | undefined;
  let workspaceStrategy: WorkspaceStrategy | undefined;
  let executionEnvironment: ExecutionEnvironment | undefined;
  let perPrdIterations: number[] = [];
  let createPrdPrompt: string | undefined;

  for (let index = cursor; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '-h' || arg === '--help') {
      return {
        command,
        help: true,
        wizard: false,
        verbose: false,
        dryRun,
        tool,
        schedule,
        workspaceStrategy,
        executionEnvironment,
        maxIterations,
        perPrdIterations
      };
    }

    if (arg === '--wizard') {
      wizard = true;
      continue;
    }

    if (arg === '--verbose') {
      verbose = true;
      continue;
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '--tool' && argv[index + 1]) {
      tool = argv[index + 1] as ProviderName;
      index += 1;
      continue;
    }

    if (arg.startsWith('--tool=')) {
      tool = arg.slice('--tool='.length) as ProviderName;
      continue;
    }

    if (arg === '--prds' && argv[index + 1]) {
      prdInput = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--prds=')) {
      prdInput = arg.slice('--prds='.length);
      continue;
    }

    if (arg === '--create-prd' && argv[index + 1]) {
      createPrdPrompt = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith('--create-prd=')) {
      createPrdPrompt = arg.slice('--create-prd='.length);
      continue;
    }

    if (arg === '--max-iterations' && argv[index + 1]) {
      maxIterations = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--max-iterations=')) {
      maxIterations = Number(arg.slice('--max-iterations='.length));
      continue;
    }

    if (arg === '--per-prd-iterations' && argv[index + 1]) {
      perPrdIterations = parsePerPrdIterations(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--per-prd-iterations=')) {
      perPrdIterations = parsePerPrdIterations(arg.slice('--per-prd-iterations='.length));
      continue;
    }

    if (arg === '--schedule' && argv[index + 1]) {
      schedule = normalizeSchedule(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--schedule=')) {
      schedule = normalizeSchedule(arg.slice('--schedule='.length));
      continue;
    }

    if (arg === '--workspace' && argv[index + 1]) {
      workspaceStrategy = normalizeWorkspaceStrategy(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith('--workspace=')) {
      workspaceStrategy = normalizeWorkspaceStrategy(arg.slice('--workspace='.length));
      continue;
    }

    if (arg === '--environment' && argv[index + 1]) {
      const value = argv[index + 1].trim().toLowerCase();
      executionEnvironment = value === 'devcontainer' ? 'devcontainer' : 'local';
      index += 1;
      continue;
    }

    if (arg.startsWith('--environment=')) {
      const value = arg.slice('--environment='.length).trim().toLowerCase();
      executionEnvironment = value === 'devcontainer' ? 'devcontainer' : 'local';
      continue;
    }

    if (/^\d+$/.test(arg)) {
      maxIterations = Number(arg);
      continue;
    }

    if (!prdInput) {
      prdInput = arg;
      continue;
    }

    throw new Error(`Unrecognized argument: ${arg}`);
  }

  if (tool && !['amp', 'claude', 'codex', 'copilot', 'cursor', 'gemini', 'opencode', 'qwen'].includes(tool)) {
    throw new Error(`Invalid provider "${tool}". Use amp, claude, codex, copilot, cursor, gemini, opencode, or qwen.`);
  }

  if (typeof maxIterations === 'number' && (!Number.isInteger(maxIterations) || maxIterations < 1)) {
    throw new Error('max iterations must be a positive integer.');
  }

  return {
    command,
    help: false,
    wizard,
    verbose,
    dryRun,
    tool,
    schedule,
    workspaceStrategy,
    executionEnvironment,
    maxIterations,
    perPrdIterations,
    prdInput,
    createPrdPrompt
  };
}

function printPlainSummary(summary: RalphRunSummary, rootDir: string): void {
  const state = summary.completed ? 'complete' : 'pending';
  console.log(`\nRalphi summary: ${state}`);
  for (const context of summary.contexts) {
    const usageSummary = buildCompactUsageSummary(context.usageTotals);
    const latestIteration = context.iterationHistory[context.iterationHistory.length - 1] ?? null;
    const touchedSummary =
      latestIteration && latestIteration.touchedFiles.length > 0
        ? ` :: files ${latestIteration.touchedFiles.length} (${latestIteration.touchedFiles.slice(0, 4).map(file => file.path).join(', ')}${latestIteration.touchedFiles.length > 4 ? ', ...' : ''})`
        : '';
    const latestMetrics = latestIteration
      ? ` :: ${latestIteration.exitCode}/${latestIteration.lineCount} lines/${(latestIteration.durationMs / 1000).toFixed(1)}s`
      : '';
    const failureSummary = context.lastFailure
      ? ` :: ${failureCategoryLabel(context.lastFailure.category)} :: ${context.lastFailure.summary} :: ${context.lastFailure.recoveryHint}`
      : '';
    console.log(
      `- ${displayPath(context.sourcePrd, rootDir)} :: ${context.done ? 'done' : 'pending'} :: ${context.storyProgress} :: ${context.backlogProgress}${usageSummary ? ` :: ${usageSummary}` : ''}${latestMetrics}${touchedSummary}${context.commitSha ? ` :: ${context.commitSha.slice(0, 12)}` : ''}${context.worktreeRemoved ? ' :: worktree removed' : ''}${failureSummary}`
    );
  }

  const usageRows = buildUsageDisplayRows(summary.usageTotals);
  if (usageRows.length > 0) {
    console.log(`Usage total: ${usageRows.map(row => `${row.label.toLowerCase()} ${row.value}`).join(' · ')}`);
  }

  if (summary.finalBranchName) {
    console.log(`Final merged branch: ${summary.finalBranchName}`);
  }
}

function printDoctorReport(report: Awaited<ReturnType<typeof runDoctor>>, rootDir: string): void {
  console.log(`Ralphi doctor :: ${report.status} :: ${doctorSummaryLine(report)}`);
  for (const check of report.checks) {
    console.log(`- [${check.status}] ${check.label} :: ${check.summary}`);
    if (check.detail) {
      console.log(`  ${check.detail}`);
    }
  }
}

async function runDoctorCommand(config: RalphConfig): Promise<number> {
  const report = await runDoctor(config);
  printDoctorReport(report, config.rootDir);
  return report.status === 'blocking' ? 1 : 0;
}

async function runWorktreeDoctorCommand(rootDir: string): Promise<number> {
  const ralphDir = projectRalphiDir(rootDir);
  const validation = await inspectGitWorkspace(rootDir);
  if (!validation.repository) {
    console.log('Ralphi worktree doctor :: warning :: Git repository unavailable.');
    return 1;
  }

  const entries = await inspectManagedWorktrees(rootDir, ralphDir);
  console.log(`Ralphi worktree doctor :: ${entries.length} managed entr${entries.length === 1 ? 'y' : 'ies'}`);

  if (entries.length === 0) {
    console.log(`- No Ralphi-managed worktrees under ${displayPath(validation.worktreeRoot, rootDir)}`);
    return 0;
  }

  for (const entry of entries) {
    const state = `[${entry.state}]`;
    const suffix = entry.branch ? ` :: ${entry.branch}` : '';
    const sourcePrd = entry.sourcePrd ? ` :: ${displayPath(entry.sourcePrd, rootDir)}` : '';
    console.log(`- ${state} ${displayPath(entry.path, rootDir)}${suffix}${sourcePrd}`);
    console.log(`  ${entry.reason}`);
  }

  return entries.some(entry => entry.state === 'blocking') ? 1 : 0;
}

async function runWorktreeCleanupCommand(rootDir: string, dryRun: boolean): Promise<number> {
  const result = await cleanupManagedWorktrees(rootDir, projectRalphiDir(rootDir), dryRun);
  console.log(`Ralphi worktree cleanup :: ${dryRun ? 'dry-run' : 'apply'}`);

  if (result.entries.length === 0 && result.branches.length === 0) {
    console.log('- No Ralphi-managed worktrees or branches were found.');
    return 0;
  }

  if (result.actionable.length === 0 && result.actionableBranches.length === 0) {
    console.log('- No Ralphi-managed execution worktrees or branches need cleanup.');
    return 0;
  }

  for (const entry of result.actionable) {
    console.log(`- worktree :: ${displayPath(entry.path, rootDir)} :: ${entry.reason}`);
  }

  for (const entry of result.actionableBranches) {
    const sourcePrd = entry.sourcePrd ? ` :: ${displayPath(entry.sourcePrd, rootDir)}` : '';
    console.log(`- branch :: ${entry.name}${sourcePrd} :: ${entry.reason}`);
  }

  if (dryRun) {
    console.log('Re-run without `--dry-run` to apply the cleanup.');
  } else {
    console.log('Managed worktree and branch cleanup finished.');
  }

  return 0;
}

async function runPromptPreviewCommand(config: RalphConfig): Promise<number> {
  if (config.plans.length === 0) {
    throw new Error('No PRDs were selected. Use --prds, --create-prd, or the interactive wizard.');
  }

  const skillRegistrySnapshot = await buildSkillRegistrySnapshot(config.rootDir);
  const tmpDir = path.join(config.ralphDir, '.tmp');
  await ensureDir(tmpDir);
  const skillRegistryPath = path.join(tmpDir, `skills.preview.${Date.now()}.md`);
  await writeFile(skillRegistryPath, skillRegistrySnapshot.content, 'utf8');

  try {
    for (const [index, plan] of config.plans.entries()) {
      const statePaths = resolvePlanStatePaths(config.ralphDir, plan.sourcePrd, plan.stateKey);
      const checkpoint = await loadContextCheckpoint(statePaths.runDir);
      const promptBundle = await buildPromptBundle({
        rootDir: config.rootDir,
        ralphDir: config.ralphDir,
        tool: config.tool,
        sourcePrd: plan.sourcePrd,
        runDir: statePaths.runDir,
        prdJsonPath: statePaths.prdJsonPath,
        progressFilePath: statePaths.progressFilePath,
        backlogPath: checkpoint?.backlogPath ?? statePaths.backlogPath,
        workspaceDir: checkpoint?.workspaceDir ?? config.rootDir,
        branchName: checkpoint?.branchName ?? plan.branchName,
        baseRef: checkpoint?.baseRef ?? plan.baseRef,
        iteration: Math.max((checkpoint?.iterationsRun ?? 0) + 1, 1),
        totalIterations: plan.iterations,
        scheduleMode: config.schedule,
        trackLabel: `Preview ${index + 1}/${config.plans.length}`,
        prdPosition: index + 1,
        prdTotal: config.plans.length,
        skillRegistry: skillRegistrySnapshot.content,
        skillRegistryPath,
        skillRegistrySources: skillRegistrySnapshot.skills.map(skill => ({
          kind: 'skill' as const,
          label: `${skill.name} [${skill.label}]`,
          path: skill.filePath
        }))
      });

      console.log(`\n=== ${displayPath(plan.sourcePrd, config.rootDir)} ===`);
      console.log(`Planned prompt path: ${displayPath(resolvePlanStatePaths(config.ralphDir, plan.sourcePrd, plan.stateKey).runDir, config.rootDir)}/prompts`);
      console.log(promptBundle.preview);
      console.log('\nInstruction sources:');
      for (const source of promptBundle.sources) {
        console.log(`- ${source.label} :: ${displayPath(source.path, config.rootDir)}`);
      }
    }

    return 0;
  } finally {
    await unlink(skillRegistryPath).catch(() => undefined);
  }
}

async function runPlain(config: RalphConfig): Promise<RalphRunSummary> {
  console.log(
    `Ralphi :: provider=${config.tool} schedule=${config.schedule} workspace=${config.workspaceStrategy} max=${config.maxIterations}`
  );
  console.log(`Queue: ${config.plans.map(plan => `${displayPath(plan.sourcePrd, config.rootDir)}(${plan.iterations})`).join(', ')}`);

  const summary = await runRalphi(config, event => {
    switch (event.type) {
      case 'doctor-report':
        printDoctorReport(event.report, config.rootDir);
        break;
      case 'project-config':
        console.log(`Project config: ${displayPath(event.configPath, config.rootDir)} (${event.missingSkillCount} missing skills)`);
        break;
      case 'skill-sync-progress':
        console.log(`Syncing skill ${event.current}/${event.total}: ${event.skill.name}`);
        break;
      case 'git-validation':
        console.log(
          event.validation.repository
            ? `Git: ${event.validation.currentBranch ?? 'detached'}${event.validation.clean ? '' : ' (dirty working tree)'}`
            : 'Git: unavailable'
        );
        break;
      case 'boot-log':
        console.log(`[${event.level}] ${event.message}`);
        break;
      case 'prepared':
        console.log(`Prepared ${event.contexts.length} PRD state directories.`);
        console.log(`[notification] Execution started for ${event.contexts.length} PRD workstream${event.contexts.length === 1 ? '' : 's'}.`);
        break;
      case 'wave-start':
        console.log(`Wave ${event.wave}/${event.totalWaves}`);
        break;
      case 'track-start':
        console.log(`Track ${event.contextIndex + 1}/${event.totalContexts}: ${displayPath(event.sourcePrd, config.rootDir)}`);
        break;
      case 'iteration-start':
        console.log(
          `\n[run] ${displayPath(event.context.sourcePrd, config.rootDir)} :: iteration ${event.prdIteration}/${event.context.iterationsTarget}`
        );
        break;
      case 'iteration-output':
        if (config.verbose) {
          console.log(event.line);
        }
        break;
      case 'iteration-finish':
        console.log(
          `[done] ${displayPath(event.context.sourcePrd, config.rootDir)} :: ${event.completed ? 'complete' : 'pending'} :: ${event.context.backlogProgress} :: exit ${event.exitCode} :: ${event.lineCount} lines :: ${(event.durationMs / 1000).toFixed(1)}s`
        );
        console.log(`[log] ${displayPath(event.logPath, config.rootDir)} :: last step ${event.step}`);
        const latestIteration = event.context.iterationHistory[event.context.iterationHistory.length - 1];
        if (latestIteration?.touchedFiles.length) {
          console.log(
            `[files] ${latestIteration.touchedFiles.map(file => `${file.change}:${file.path}`).join(', ')}`
          );
        }
        if (event.exitCode !== 0 || event.context.status === 'blocked') {
          const failure = event.context.lastFailure;
          console.log(
            `[notification] ${displayPath(event.context.sourcePrd, config.rootDir)} stopped :: ${failure ? `${failureCategoryLabel(failure.category)} :: ${failure.summary}` : event.context.lastError ?? `provider exit ${event.exitCode}`}`
          );
          if (failure) {
            console.log(`[next] ${failure.recoveryHint}`);
            console.log(`[retry] ${failure.retryable && failure.retryCount === 0 ? 'single retry available in the dashboard' : 'not available'}`);
          }
        }
        break;
      case 'summary':
        console.log(
          `[notification] Execution ${event.summary.completed ? 'finished' : 'paused'} :: ${event.summary.contexts.filter(context => context.done).length}/${event.summary.contexts.length} PRDs complete`
        );
        printPlainSummary(event.summary, config.rootDir);
        break;
      default:
        break;
    }
  });

  return summary;
}

export async function createInitialConfig(parsed: ParsedArgs, rootDir: string, cwd: string): Promise<RalphConfig> {
  await migrateLegacyProjectRuntime(rootDir);
  const ralphDir = projectRalphiDir(rootDir);
  const project = await loadProjectConfig(rootDir);
  const prdFiles = parsed.createPrdPrompt ? [] : await resolvePrdFiles(rootDir, parsed.prdInput, cwd);
  const defaults = project.config.defaults;

  const tool = parsed.tool ?? defaults.tool ?? 'amp';
  const schedule = parsed.schedule ?? defaults.schedule ?? 'round-robin';
  const devcontainerConfigPath = await findDevcontainerConfig(rootDir);
  const maxIterations = parsed.maxIterations ?? defaults.iterations ?? 10;
  const executionEnvironment =
    parsed.executionEnvironment ??
    (defaults.environment === 'devcontainer' && devcontainerConfigPath ? 'devcontainer' : defaults.environment) ??
    'local';
  const plans = await buildPlansFromPrds(prdFiles, maxIterations, parsed.perPrdIterations);
  const workspaceStrategy =
    schedule === 'parallel' || plans.length > 1 ? 'worktree' : parsed.workspaceStrategy ?? defaults.workspaceStrategy ?? 'worktree';

  return {
    rootDir,
    ralphDir,
    tool,
    executionSkills: buildExecutionSkills(rootDir, tool, project.config),
    plans,
    maxIterations,
    schedule,
    verbose: parsed.verbose || defaults.verbose || false,
    workspaceStrategy,
    executionEnvironment: executionEnvironment === 'devcontainer' && devcontainerConfigPath ? 'devcontainer' : 'local',
    devcontainerConfigPath,
    launchMode: parsed.createPrdPrompt ? 'create-prd' : 'run-existing',
    createPrdPrompt: parsed.createPrdPrompt,
    projectConfigPath: projectConfigPath(rootDir),
    projectConfig: project.config,
    projectConfigCreated: project.created,
    projectContextMode: project.detected ? 'contextual' : 'global'
  };
}

export async function materializeDraftIfNeeded(config: RalphConfig): Promise<RalphConfig> {
  if (config.launchMode !== 'create-prd' || !config.createPrdPrompt?.trim()) {
    return config;
  }

  const prdFile = await createPrdDraftFromBrief(config.rootDir, config.createPrdPrompt);
  const plans = await buildPlansFromPrds([prdFile], config.maxIterations, config.plans.map(plan => plan.iterations));

  return {
    ...config,
    launchMode: 'run-existing',
    plans
  };
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    console.log(usage());
    return 0;
  }

  let leaveFullscreen: (() => void) | undefined;
  let cleanupRegistered = false;

  if (process.stdout.isTTY && parsed.command === 'run') {
    leaveFullscreen = enterFullscreenTerminal();
    process.once('exit', leaveFullscreen);
    cleanupRegistered = true;
  }

  try {
    const cwd = process.cwd();
    const rootDir = await findProjectRoot(cwd);
    await migrateLegacyProjectRuntime(rootDir);
    if (parsed.command === 'worktree-doctor') {
      return runWorktreeDoctorCommand(rootDir);
    }

    if (parsed.command === 'worktree-cleanup') {
      return runWorktreeCleanupCommand(rootDir, parsed.dryRun);
    }

    let config = await createInitialConfig(parsed, rootDir, cwd);

    if (parsed.command === 'doctor') {
      return runDoctorCommand(config);
    }

    if (parsed.command === 'prompt-preview') {
      config = await materializeDraftIfNeeded(config);
      return runPromptPreviewCommand(config);
    }

    let shouldLaunchWizard = parsed.wizard || (process.argv.length <= 2 && process.stdout.isTTY);

    while (true) {
      if (shouldLaunchWizard) {
        if (!process.stdout.isTTY) {
          throw new Error('The interactive wizard requires a TTY.');
        }

        const prdOptions = await scanPrdDirectory(rootDir);
        config = await runWizard({
          rootDir,
          ralphDir: projectRalphiDir(rootDir),
          prdOptions,
          initial: config
        });
      }

      config = await materializeDraftIfNeeded(config);

      if (config.plans.length === 0) {
        throw new Error('No PRDs were selected. Use --prds, --create-prd, or the interactive wizard.');
      }

      if (!process.stdout.isTTY) {
        const summary = await runPlain(config);
        return summary.completed ? 0 : 1;
      }

      const dashboardResult = await runDashboard(config);
      if (dashboardResult.nextAction === 'restart-wizard') {
        config = await createInitialConfig(parsed, rootDir, cwd);
        shouldLaunchWizard = true;
        continue;
      }

      if (
        dashboardResult.nextAction === 'resume-session' ||
        dashboardResult.nextAction === 'restart-session' ||
        dashboardResult.nextAction === 'discard-session'
      ) {
        let pendingSession = await loadPendingRunSession(projectRalphiDir(rootDir));
        if (!pendingSession && dashboardResult.nextAction === 'resume-session') {
          const checkpoints = await listCheckpointSnapshots(config);
          if (checkpoints.length > 0) {
            pendingSession = await saveRunSession(config.ralphDir, config, 'blocked', dashboardResult.summary);
          }
        }

        if (!pendingSession) {
          if (dashboardResult.nextAction === 'resume-session') {
            shouldLaunchWizard = false;
            continue;
          }

          config = await createInitialConfig(parsed, rootDir, cwd);
          shouldLaunchWizard = true;
          continue;
        }

        if (dashboardResult.nextAction === 'restart-session' || dashboardResult.nextAction === 'discard-session') {
          await clearRunState(pendingSession.config);
        }

        if (dashboardResult.nextAction === 'discard-session') {
          config = await createInitialConfig(parsed, rootDir, cwd);
          shouldLaunchWizard = true;
          continue;
        }

        config = pendingSession.config;
        shouldLaunchWizard = false;
        continue;
      }

      return dashboardResult.summary.completed ? 0 : 1;
    }
  } finally {
    if (leaveFullscreen) {
      if (cleanupRegistered) {
        process.removeListener('exit', leaveFullscreen);
      }
      leaveFullscreen();
    }
  }
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }

  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entryPath) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isDirectExecution()) {
  runCli()
    .then(code => {
      process.exit(code);
    })
    .catch((error: Error) => {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    });
}
