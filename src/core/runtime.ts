import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, cp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import { applyBacklogMarker, ensureBacklog, isBacklogComplete, loadBacklog, refreshBacklog, resetBacklogProgress, saveBacklogSnapshot } from './backlog.js';
import { ensureDevcontainerWorkspace, findDevcontainerExecutable } from './devcontainer.js';
import { runDoctor } from './doctor.js';
import { classifyFailure, mergeMcpServerSignal, parseMcpServerSignal } from './failure.js';
import {
  captureWorkspaceFootprint,
  commitWorkspaceChanges,
  extractTouchedFileHints,
  inspectGitWorkspace,
  provisionWorktrees,
  removeGitBranch,
  removeGitWorktree,
  runGitCommand,
  summarizeTouchedFiles,
  type WorkspaceFootprint
} from './git.js';
import { validatePlanDependencies } from './dependencies.js';
import { dispatchProjectNotification, notificationChannelLabel, type ProjectNotificationRequest } from './notifications.js';
import { renderPrdMarkdown, type PrdDraftInput } from './prd.js';
import { buildPromptBundle, persistPromptBundle, resolvePromptArtifactPaths, type PromptSourceMeta } from './prompt.js';
import { projectRalphiDir, providerExecutableName, providerSkillTarget, resolveSkillTargetDir, syncProjectSkills } from './project.js';
import { loadContextCheckpoint, loadPendingRunSession, saveContextCheckpoint, saveRunSession } from './session.js';
import { buildSkillRegistrySnapshot, builtinSkillFile, loadSkillFile } from './skills.js';
import type {
  BacklogSnapshot,
  ProviderName,
  RalphConfig,
  RalphContextSnapshot,
  RalphEvent,
  RalphPrdPlan,
  RalphReporter,
  RalphRunSummary
} from './types.js';
import { aggregateUsageTotals, extractUsageTotalsFromOutput, mergeUsageTotals } from './usage.js';
import {
  backlogProgressLabel,
  classifyOutputLine,
  deriveBranchName,
  displayPath,
  ensureArrayLength,
  ensureDir,
  extractBacklogMarker,
  extractJsonBranch,
  findExecutable,
  isJsonFile,
  newerThan,
  parsePositiveIntegerList,
  pathExists,
  prdJsonComplete,
  resolvePrimaryPrdDir,
  resolvePrdDirCandidates,
  sanitizeBranchName,
  slugify,
  sourceSlug,
  splitCommaList,
  storyProgressLabel
} from './utils.js';

interface InternalContext {
  snapshot: RalphContextSnapshot;
  sourceMetaPath: string;
  devcontainerReady: boolean;
  provisionedSkillPaths: string[];
}

interface ProviderExecutionResult {
  durationMs: number;
  exitCode: number;
  lineCount: number;
  sawComplete: boolean;
  step: string;
  usageTotals: RalphRunSummary['usageTotals'];
  rawOutput: string;
  timedOut: boolean;
  launchError: string | null;
  mcpServers: RalphContextSnapshot['mcpServers'];
}

interface PreparedWorkspace {
  skillRegistryPath: string;
  skillRegistry: string;
  skillRegistrySources: PromptSourceMeta[];
}

interface CreatePrdDraftOptions {
  skillName?: string;
  skillFilePath?: string;
  provider?: ProviderName;
  verbose?: boolean;
  onProgress?: (message: string) => void;
}

interface ProviderPromptResult {
  exitCode: number;
  output: string;
}

type ProviderInvocationMode = 'execution' | 'planning';

interface GenerateBacklogWithSkillOptions {
  rootDir: string;
  ralphDir: string;
  sourcePrd: string;
  skillName: string;
  skillFilePath: string;
  provider: ProviderName;
  verbose?: boolean;
  onProgress?: (message: string) => void;
}

function workspaceDirs(ralphDir: string) {
  return {
    stateDir: path.join(ralphDir, 'state'),
    archiveDir: path.join(ralphDir, 'archive'),
    tmpDir: path.join(ralphDir, '.tmp')
  };
}

function backlogPlanPath(runDir: string): string {
  return path.join(runDir, 'plan.json');
}

export async function isContextPersistedStateComplete(prdJsonPath: string, backlog: BacklogSnapshot | null): Promise<boolean> {
  const storiesComplete = await prdJsonComplete(prdJsonPath);
  return storiesComplete && isBacklogComplete(backlog);
}

export function resolvePlanStatePaths(ralphDir: string, sourcePrd: string, stateKey?: string) {
  const { stateDir } = workspaceDirs(ralphDir);
  const runSlug = stateKey?.trim() || sourceSlug(sourcePrd);
  const runDir = path.join(stateDir, runSlug);

  return {
    runSlug,
    runDir,
    logDir: path.join(runDir, 'logs'),
    prdJsonPath: path.join(runDir, 'prd.json'),
    progressFilePath: path.join(runDir, 'progress.txt'),
    sourceMetaPath: path.join(runDir, 'source.txt'),
    backlogPath: path.join(runDir, 'backlog.json'),
    checkpointPath: path.join(runDir, 'checkpoint.json')
  };
}

function formatDateStamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}-${hour}${minute}${second}`;
}

function buildManagedBranchName(baseBranchName: string): string {
  return sanitizeBranchName(`${baseBranchName}-${randomUUID().slice(0, 8)}`);
}

function findContextByPlanId(contexts: InternalContext[], planId: string | null | undefined): InternalContext | null {
  if (!planId) {
    return null;
  }

  return contexts.find(context => context.snapshot.planId === planId) ?? null;
}

function dependencyReady(config: RalphConfig, context: InternalContext, contexts: InternalContext[]): boolean {
  if (context.snapshot.iterationsRun > 0) {
    return true;
  }

  const dependency = findContextByPlanId(contexts, context.snapshot.dependsOnPlanId);
  if (!dependency) {
    return true;
  }

  if (!dependency.snapshot.done) {
    return false;
  }

  if (config.workspaceStrategy === 'worktree' && dependency.snapshot.worktreePath) {
    return dependency.snapshot.worktreeRemoved;
  }

  return true;
}

async function markContextWaitingForDependency(
  context: InternalContext,
  contexts: InternalContext[],
  reporter?: RalphReporter
): Promise<void> {
  const dependency = findContextByPlanId(contexts, context.snapshot.dependsOnPlanId);
  if (!dependency) {
    return;
  }

  const nextStep = `Waiting for ${dependency.snapshot.title} to finish`;
  if (context.snapshot.lastStep === nextStep && context.snapshot.status === 'queued') {
    return;
  }

  context.snapshot.status = 'queued';
  context.snapshot.lastStep = nextStep;
  await saveContextCheckpoint({ ...context.snapshot });
  await emit(reporter, {
    type: 'boot-log',
    level: 'info',
    message: `${context.snapshot.title}: waiting for ${dependency.snapshot.title} before starting.`,
    contextIndex: context.snapshot.index
  });
}

function orderContextsByDependency(contexts: InternalContext[]): InternalContext[] {
  const orderedIds = validatePlanDependencies(
    contexts.map(context => ({
      id: context.snapshot.planId,
      title: context.snapshot.title,
      dependsOn: context.snapshot.dependsOnPlanId
    }))
  );
  const contextMap = new Map(contexts.map(context => [context.snapshot.planId, context] as const));
  return orderedIds.map(planId => contextMap.get(planId)).filter((context): context is InternalContext => Boolean(context));
}

async function ensureContextExecutionReady(
  config: RalphConfig,
  context: InternalContext,
  contexts: InternalContext[],
  reporter?: RalphReporter
): Promise<void> {
  if (config.workspaceStrategy !== 'worktree') {
    context.snapshot.workspaceDir = config.rootDir;
    if (context.provisionedSkillPaths.length === 0) {
      await provisionExecutionSkills(config, [context], reporter);
    }
    return;
  }

  const validation = await inspectGitWorkspace(config.rootDir);
  if (!validation.repository) {
    context.snapshot.workspaceDir = config.rootDir;
    if (context.provisionedSkillPaths.length === 0) {
      await provisionExecutionSkills(config, [context], reporter);
    }
    return;
  }

  if (context.snapshot.worktreePath && (await pathExists(context.snapshot.worktreePath))) {
    context.snapshot.workspaceDir = context.snapshot.worktreePath;
    if (context.provisionedSkillPaths.length === 0) {
      await provisionExecutionSkills(config, [context], reporter);
    }
    return;
  }

  const dependency = findContextByPlanId(contexts, context.snapshot.dependsOnPlanId);
  if (dependency?.snapshot.branchName) {
    context.snapshot.baseRef = dependency.snapshot.branchName;
  }

  const knownWorktreePath = context.snapshot.worktreePath;
  const worktreeExisted = knownWorktreePath ? await pathExists(knownWorktreePath) : false;
  await provisionWorktrees(config, [context.snapshot], validation, async (message, contextIndex) => {
    await emit(reporter, {
      type: 'boot-log',
      level: 'info',
      message,
      contextIndex
    });
  });

  if (context.snapshot.worktreePath) {
    context.snapshot.workspaceDir = context.snapshot.worktreePath;
    await emit(reporter, {
      type: 'worktree-ready',
      context: { ...context.snapshot },
      created: !worktreeExisted
    });
  }

  if (context.provisionedSkillPaths.length === 0) {
    await provisionExecutionSkills(config, [context], reporter);
  }
  await saveContextCheckpoint({ ...context.snapshot });
}

async function finalizeContextArtifacts(config: RalphConfig, context: InternalContext, reporter?: RalphReporter): Promise<void> {
  if (config.workspaceStrategy === 'shared' || !context.snapshot.done || !context.snapshot.worktreePath || context.snapshot.worktreeRemoved) {
    return;
  }

  const validation = await inspectGitWorkspace(config.rootDir);
  if (!validation.repository) {
    return;
  }

  const worktreePath = context.snapshot.worktreePath;
  context.snapshot.lastStep = 'Finalizing git workspace';

  await emit(reporter, {
    type: 'boot-log',
    level: 'info',
    message: `${context.snapshot.title}: finalizing ${context.snapshot.branchName ?? 'workspace'} before releasing the dependency chain.`,
    contextIndex: context.snapshot.index
  });

  try {
    if (!(await pathExists(worktreePath))) {
      throw new Error(`Worktree ${displayPath(worktreePath, validation.rootDir)} is unavailable for finalization.`);
    }

    await cleanupProvisionedSkills(context, reporter);

    const commitResult = await commitWorkspaceChanges({
      workspaceDir: worktreePath,
      sourcePrd: context.snapshot.sourcePrd,
      title: context.snapshot.title
    });

    context.snapshot.commitSha = commitResult.commitSha;
    context.snapshot.commitMessage = commitResult.commitMessage;
    context.snapshot.lastError = null;
    context.snapshot.lastFailure = null;

    await emit(reporter, {
      type: 'boot-log',
      level: commitResult.committed ? 'success' : 'info',
      message: commitResult.committed
        ? `${context.snapshot.title}: committed ${commitResult.commitSha?.slice(0, 12) ?? context.snapshot.branchName ?? 'branch'}.`
        : `${context.snapshot.title}: no code changes to commit.`,
      contextIndex: context.snapshot.index
    });

    await removeGitWorktree(validation.rootDir, worktreePath);
    context.snapshot.worktreeRemoved = true;
    context.snapshot.workspaceDir = validation.rootDir;
    context.snapshot.lastStep = commitResult.committed ? 'Committed task and released worktree' : 'Released worktree';

    await emit(reporter, {
      type: 'boot-log',
      level: 'success',
      message: `${context.snapshot.title}: released worktree ${displayPath(worktreePath, validation.rootDir)}.`,
      contextIndex: context.snapshot.index
    });
    await saveContextCheckpoint({ ...context.snapshot });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to finalize the git workspace.';
    context.snapshot.done = false;
    context.snapshot.status = 'blocked';
    context.snapshot.lastFailure = classifyFailure({
      message,
      rawLogPath: context.snapshot.lastLogPath,
      retryCount: context.snapshot.lastFailure?.retryCount ?? 0
    });
    context.snapshot.lastError = context.snapshot.lastFailure.summary;
    context.snapshot.lastStep = 'Git finalization failed';

    await emit(reporter, {
      type: 'boot-log',
      level: 'error',
      message: `${context.snapshot.title}: ${message}`,
      contextIndex: context.snapshot.index
    });
    await saveContextCheckpoint({ ...context.snapshot });
  }
}

async function createFinalMergedBranch(
  config: RalphConfig,
  contexts: InternalContext[],
  reporter?: RalphReporter
): Promise<string | null> {
  if (config.workspaceStrategy !== 'worktree' || contexts.length < 2 || contexts.some(context => !context.snapshot.done)) {
    return null;
  }

  const validation = await inspectGitWorkspace(config.rootDir);
  if (!validation.repository) {
    return null;
  }

  const orderedContexts = orderContextsByDependency(contexts);
  const baseRef =
    orderedContexts.find(context => !context.snapshot.dependsOnPlanId)?.snapshot.baseRef ||
    validation.currentBranch ||
    validation.defaultBranch ||
    'HEAD';
  const finalBranchName = buildManagedBranchName('ralphi/merged');
  const mergeWorktreePath = path.join(validation.worktreeRoot, slugify(finalBranchName));

  await ensureDir(validation.worktreeRoot);
  const addResult = await runGitCommand(validation.rootDir, ['worktree', 'add', '-b', finalBranchName, mergeWorktreePath, baseRef]);
  if (addResult.code !== 0) {
    throw new Error(addResult.stderr.trim() || addResult.stdout.trim() || 'Unable to create the final merged branch worktree.');
  }

  try {
    for (const context of orderedContexts) {
      if (!context.snapshot.branchName) {
        continue;
      }

      const mergeResult = await runGitCommand(mergeWorktreePath, ['merge', '--no-edit', context.snapshot.branchName]);
      if (mergeResult.code !== 0) {
        await runGitCommand(mergeWorktreePath, ['merge', '--abort']).catch(() => ({ code: 0, stdout: '', stderr: '' }));
        throw new Error(
          mergeResult.stderr.trim() ||
            mergeResult.stdout.trim() ||
            `Unable to merge ${context.snapshot.branchName} into the final execution branch.`
        );
      }
    }
  } finally {
    await removeGitWorktree(validation.rootDir, mergeWorktreePath).catch(async () => {
      await rm(mergeWorktreePath, { recursive: true, force: true });
    });
  }

  await emit(reporter, {
    type: 'boot-log',
    level: 'success',
    message: `Created final merged branch ${finalBranchName}.`
  });

  return finalBranchName;
}

async function cleanupExecutionBranches(config: RalphConfig, contexts: InternalContext[], reporter?: RalphReporter): Promise<void> {
  if (config.workspaceStrategy !== 'worktree' || contexts.length < 2) {
    return;
  }

  const validation = await inspectGitWorkspace(config.rootDir);
  if (!validation.repository) {
    return;
  }

  for (const context of contexts) {
    if (context.snapshot.worktreePath && !context.snapshot.worktreeRemoved) {
      await removeGitWorktree(validation.rootDir, context.snapshot.worktreePath).catch(() => undefined);
      context.snapshot.worktreeRemoved = true;
      context.snapshot.workspaceDir = validation.rootDir;
    }

    if (!context.snapshot.branchName || context.snapshot.branchRemoved) {
      continue;
    }

    await removeGitBranch(validation.rootDir, context.snapshot.branchName);
    context.snapshot.branchRemoved = true;
    context.snapshot.lastStep = 'Merged into final execution branch';
    await saveContextCheckpoint({ ...context.snapshot });

    await emit(reporter, {
      type: 'boot-log',
      level: 'success',
      message: `${context.snapshot.title}: cleaned branch ${context.snapshot.branchName}.`,
      contextIndex: context.snapshot.index
    });
  }
}

async function emit(reporter: RalphReporter | undefined, event: RalphEvent): Promise<void> {
  await reporter?.(event);
}

async function sendLifecycleNotifications(
  config: RalphConfig,
  reporter: RalphReporter | undefined,
  request: ProjectNotificationRequest
): Promise<void> {
  const result = await dispatchProjectNotification(config.projectConfig.notifications, request);
  if (!reporter || result.failures.length === 0) {
    return;
  }

  const detail = result.failures
    .map(failure => `${notificationChannelLabel(failure.channel)}: ${failure.message}`)
    .join(' · ');

  await reporter({
    type: 'boot-log',
    level: 'warning',
    message: `Notification delivery warning. ${detail}`
  });
}

async function copyIfExists(sourcePath: string, targetPath: string): Promise<void> {
  if (await pathExists(sourcePath)) {
    await cp(sourcePath, targetPath, { force: true });
  }
}

async function resetProgressFile(progressFilePath: string, sourcePrd: string, reason?: string): Promise<void> {
  const content = ['# Ralphi Progress Log', `Started: ${new Date().toString()}`, `Source PRD: ${sourcePrd}`];

  if (reason) {
    content.push(`Reason: ${reason}`);
  }

  content.push('---', '');
  await writeFile(progressFilePath, content.join('\n'), 'utf8');
}

async function ensureProgressFile(progressFilePath: string, sourcePrd: string): Promise<void> {
  if (!(await pathExists(progressFilePath))) {
    await resetProgressFile(progressFilePath, sourcePrd);
  }
}

async function archiveRunState(runDir: string, archiveDir: string, label: string): Promise<void> {
  const prdJsonPath = path.join(runDir, 'prd.json');
  const progressFilePath = path.join(runDir, 'progress.txt');
  const sourceMetaPath = path.join(runDir, 'source.txt');
  const backlogPath = path.join(runDir, 'backlog.json');

  if (!(await pathExists(prdJsonPath)) && !(await pathExists(progressFilePath)) && !(await pathExists(backlogPath))) {
    return;
  }

  const archiveTarget = path.join(archiveDir, `${formatDateStamp()}-${sourceSlug(label)}`);
  await ensureDir(archiveTarget);
  await copyIfExists(prdJsonPath, path.join(archiveTarget, 'prd.json'));
  await copyIfExists(progressFilePath, path.join(archiveTarget, 'progress.txt'));
  await copyIfExists(sourceMetaPath, path.join(archiveTarget, 'source.txt'));
  await copyIfExists(backlogPath, path.join(archiveTarget, 'backlog.json'));
}

async function syncSourcePrd(sourcePrd: string, runDir: string, archiveDir: string): Promise<void> {
  const prdJsonPath = path.join(runDir, 'prd.json');
  const progressFilePath = path.join(runDir, 'progress.txt');
  const sourceMetaPath = path.join(runDir, 'source.txt');
  const backlogPath = path.join(runDir, 'backlog.json');
  const checkpointPath = path.join(runDir, 'checkpoint.json');

  await ensureDir(runDir);
  await writeFile(sourceMetaPath, `${sourcePrd}\n`, 'utf8');

  if (await isJsonFile(sourcePrd)) {
    if (!(await pathExists(prdJsonPath))) {
      await copyFile(sourcePrd, prdJsonPath);
      await resetProgressFile(progressFilePath, sourcePrd, 'Initialized from source JSON.');
      await rm(backlogPath, { force: true });
      await rm(checkpointPath, { force: true });
      return;
    }

    const sameContent = (await readFile(sourcePrd, 'utf8')) === (await readFile(prdJsonPath, 'utf8'));
    if (!sameContent && (await newerThan(sourcePrd, prdJsonPath))) {
      const oldBranch = await extractJsonBranch(prdJsonPath);
      const newBranch = await extractJsonBranch(sourcePrd);
      const label = oldBranch || path.basename(sourcePrd);

      await archiveRunState(runDir, archiveDir, label);
      await copyFile(sourcePrd, prdJsonPath);
      await rm(backlogPath, { force: true });
      await rm(checkpointPath, { force: true });

      if (oldBranch && newBranch && oldBranch !== newBranch) {
        await resetProgressFile(progressFilePath, sourcePrd, `Branch changed from ${oldBranch} to ${newBranch}.`);
      } else {
        await resetProgressFile(progressFilePath, sourcePrd, 'Source JSON changed; run state refreshed.');
      }
      return;
    }

    await ensureProgressFile(progressFilePath, sourcePrd);
    return;
  }

  if ((await pathExists(prdJsonPath)) && (await newerThan(sourcePrd, prdJsonPath))) {
    await archiveRunState(runDir, archiveDir, `${path.basename(sourcePrd)}-source-updated`);
    await rm(prdJsonPath, { force: true });
    await rm(backlogPath, { force: true });
    await rm(checkpointPath, { force: true });
    await resetProgressFile(progressFilePath, sourcePrd, 'Source PRD changed; plan will be regenerated.');
    return;
  }

  await ensureProgressFile(progressFilePath, sourcePrd);
}

async function createContext(
  config: RalphConfig,
  plan: RalphPrdPlan,
  index: number,
  resumeFromCheckpoint: boolean
): Promise<InternalContext> {
  const { archiveDir } = workspaceDirs(config.ralphDir);
  const { runSlug, runDir, logDir, prdJsonPath, progressFilePath, sourceMetaPath, backlogPath: defaultBacklogPath } = resolvePlanStatePaths(
    config.ralphDir,
    plan.sourcePrd,
    plan.stateKey
  );
  const backlogPath = plan.backlogPath ?? defaultBacklogPath;

  await ensureDir(logDir);
  await syncSourcePrd(plan.sourcePrd, runDir, archiveDir);

  const checkpoint = resumeFromCheckpoint ? await loadContextCheckpoint(runDir) : null;
  const dependencyPlan = config.plans.find(candidate => candidate.id === plan.dependsOn) ?? null;
  const baseBranchName =
    plan.branchName ||
    ((await pathExists(prdJsonPath)) ? await extractJsonBranch(prdJsonPath) : '') ||
    deriveBranchName(plan.sourcePrd);
  const branchName = checkpoint?.branchName || buildManagedBranchName(baseBranchName);
  let backlog = await ensureBacklog(plan.sourcePrd, prdJsonPath, backlogPath).catch(() => null);
  if (plan.resetBacklog && backlog && isBacklogComplete(backlog)) {
    backlog = await resetBacklogProgress(backlogPath) ?? backlog;
  }
  const restoredBacklog = backlog ?? checkpoint?.backlog ?? null;
  const done = await isContextPersistedStateComplete(prdJsonPath, restoredBacklog);
  const activeItemId = restoredBacklog?.activeItemId ?? checkpoint?.activeBacklogItemId ?? null;
  const activeStepId = restoredBacklog?.activeStepId ?? checkpoint?.activeBacklogStepId ?? null;
  const restoredStatus =
    checkpoint?.lastError || checkpoint?.lastFailure
      ? 'blocked'
      : done
        ? 'complete'
        : 'queued';

  return {
    sourceMetaPath,
    devcontainerReady: false,
    provisionedSkillPaths: [],
    snapshot: {
      index,
      planId: plan.id,
      sourcePrd: plan.sourcePrd,
      sourceLabel: path.basename(plan.sourcePrd),
      title: plan.title,
      dependsOnPlanId: checkpoint?.dependsOnPlanId ?? plan.dependsOn ?? null,
      dependsOnTitle: checkpoint?.dependsOnTitle ?? dependencyPlan?.title ?? null,
      runSlug,
      runDir,
      logDir,
      prdJsonPath,
      progressFilePath,
      backlogPath,
      workspaceDir: checkpoint?.workspaceDir || config.rootDir,
      branchName: branchName || null,
      baseRef: checkpoint?.baseRef || plan.baseRef || null,
      worktreePath: checkpoint?.worktreePath || plan.worktreePath || null,
      worktreeRemoved: checkpoint?.worktreeRemoved ?? false,
      branchRemoved: checkpoint?.branchRemoved ?? false,
      storyProgress: await storyProgressLabel(prdJsonPath),
      backlogProgress: backlogProgressLabel(restoredBacklog),
      backlog: restoredBacklog,
      status: restoredStatus,
      done,
      iterationsRun: checkpoint?.iterationsRun ?? 0,
      iterationsTarget: plan.iterations,
      lastLogPath: checkpoint?.lastLogPath ?? null,
      activeBacklogItemId: activeItemId,
      activeBacklogStepId: activeStepId,
      commitSha: checkpoint?.commitSha ?? null,
      commitMessage: checkpoint?.commitMessage ?? null,
      usageTotals: checkpoint?.usageTotals ?? null,
      lastStep: checkpoint?.lastStep ?? 'Preparing workspace',
      lastError: done ? null : checkpoint?.lastError ?? null,
      lastFailure: done ? null : checkpoint?.lastFailure ?? null,
      iterationHistory: checkpoint?.iterationHistory ?? [],
      lastPromptPath: checkpoint?.lastPromptPath ?? null,
      lastPromptPreviewPath: checkpoint?.lastPromptPreviewPath ?? null,
      lastPromptSourcesPath: checkpoint?.lastPromptSourcesPath ?? null,
      mcpServers: checkpoint?.mcpServers ?? []
    }
  };
}

function runSessionStatus(contexts: InternalContext[]): 'running' | 'blocked' | 'complete' {
  const requiresBranchCleanup = contexts.length > 1;
  if (
    contexts.length > 0 &&
    contexts.every(context => context.snapshot.done) &&
    contexts.every(context => (requiresBranchCleanup ? context.snapshot.branchRemoved || !context.snapshot.branchName : true))
  ) {
    return 'complete';
  }

  if (contexts.some(context => !context.snapshot.done && Boolean(context.snapshot.lastError))) {
    return 'blocked';
  }

  return 'running';
}

function isSameRunPlan(left: RalphPrdPlan, right: RalphPrdPlan): boolean {
  return left.stateKey === right.stateKey && left.sourcePrd === right.sourcePrd && (left.dependsOn ?? null) === (right.dependsOn ?? null);
}

function shouldResumePendingRun(config: RalphConfig, pendingConfig: RalphConfig | null): boolean {
  if (!pendingConfig) {
    return false;
  }

  if (
    pendingConfig.tool !== config.tool ||
    pendingConfig.schedule !== config.schedule ||
    pendingConfig.workspaceStrategy !== config.workspaceStrategy ||
    pendingConfig.executionEnvironment !== config.executionEnvironment
  ) {
    return false;
  }

  if (pendingConfig.plans.length !== config.plans.length) {
    return false;
  }

  return pendingConfig.plans.every((plan, index) => isSameRunPlan(plan, config.plans[index]));
}

async function ensureWorkspace(config: RalphConfig): Promise<PreparedWorkspace> {
  const { stateDir, archiveDir, tmpDir } = workspaceDirs(config.ralphDir);
  await Promise.all([ensureDir(config.ralphDir), ensureDir(stateDir), ensureDir(archiveDir), ensureDir(tmpDir)]);

  const skillRegistrySnapshot = await buildSkillRegistrySnapshot(config.rootDir);
  const skillRegistryPath = path.join(tmpDir, `skills.${randomUUID()}.md`);
  await writeFile(skillRegistryPath, skillRegistrySnapshot.content, 'utf8');
  return {
    skillRegistryPath,
    skillRegistry: skillRegistrySnapshot.content,
    skillRegistrySources: skillRegistrySnapshot.skills.map(skill => ({
      kind: 'skill',
      label: `${skill.name} [${skill.label}]`,
      path: skill.filePath
    }))
  };
}

type ProviderPromptTransport = 'stdin' | 'arg';

interface ProviderInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  promptTransport: ProviderPromptTransport;
}

function buildProviderInvocation(
  tool: ProviderName,
  workspaceDir: string,
  verbose: boolean,
  mode: ProviderInvocationMode = 'execution',
  executionEnvironment: RalphConfig['executionEnvironment'] = 'local'
): ProviderInvocation {
  const env = { ...process.env };
  const workspaceArg = executionEnvironment === 'devcontainer' && mode === 'execution' ? '.' : workspaceDir;

  const wrapInvocation = (command: string, args: string[], promptTransport: ProviderPromptTransport): ProviderInvocation => {
    if (executionEnvironment === 'devcontainer' && mode === 'execution') {
      return {
        command: 'devcontainer',
        args: ['exec', '--workspace-folder', workspaceDir, command, ...args],
        env,
        cwd: workspaceDir,
        promptTransport
      };
    }

    return {
      command,
      args,
      env,
      cwd: workspaceDir,
      promptTransport
    };
  };

  switch (tool) {
    case 'amp':
      if (verbose) {
        env.FORCE_COLOR = '1';
        env.CLICOLOR_FORCE = '1';
        env.TERM = env.TERM || 'xterm-256color';
      } else {
        env.NO_COLOR = '1';
      }
      return wrapInvocation('amp', ['--dangerously-allow-all'], 'stdin');
    case 'claude':
      if (verbose) {
        env.FORCE_COLOR = '1';
        env.CLICOLOR_FORCE = '1';
        env.TERM = env.TERM || 'xterm-256color';
      } else {
        env.NO_COLOR = '1';
      }
      return wrapInvocation('claude', ['--dangerously-skip-permissions', '--print'], 'stdin');
    case 'codex': {
      const codexArgs = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--color', verbose ? 'always' : 'never'];
      if (mode === 'planning') {
        codexArgs.push('--ephemeral');
      }
      codexArgs.push('-C', workspaceArg, '-');
      return wrapInvocation('codex', codexArgs, 'stdin');
    }
    case 'copilot':
      return wrapInvocation('copilot', ['--output-format', 'json', '--allow-all', '--prompt'], 'arg');
    case 'cursor':
      return wrapInvocation(providerExecutableName(tool), ['--force', '--output-format', 'stream-json', '-p'], 'arg');
    case 'gemini':
      return wrapInvocation('gemini', ['--output-format', 'stream-json', '--yolo', '-p'], 'arg');
    case 'opencode':
      return wrapInvocation('opencode', ['run', '--format', 'json'], 'stdin');
    case 'qwen':
      return wrapInvocation('qwen', ['--output-format', 'stream-json', '--approval-mode', 'yolo', '-p'], 'arg');
  }
}

function summarizeProviderOutput(output: string, lines = 12): string {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join('\n');
}

function buildPrdSkillPrompt(rootDir: string, targetPath: string, input: PrdDraftInput, skillName: string, skillContent: string): string {
  return `You are Ralphi's planning worker inside the repository at ${rootDir}.

Task:
- Create or overwrite the PRD markdown file at ${targetPath}.
- Use the skill below as the primary workflow and structure.

Constraints:
- Do not ask follow-up questions.
- Never ask the user for clarification. If details are missing, make the smallest reasonable assumption and continue.
- Do not implement code or modify application files.
- Do not inspect unrelated repository files. Stay focused on the provided brief and the target PRD file.
- If the skill mentions another output location, ignore it and write to ${targetPath}.
- The PRD must be complete enough to drive backlog generation immediately after this step.
- Keep user stories small, explicit, and independently deliverable.
- Finish immediately after saving ${targetPath}.

Provided input:
- Title: ${input.title}
- Description:
${input.description}

Selected skill: ${skillName}
Skill instructions:
${skillContent}

Return a short confirmation after saving the PRD.`;
}

function buildPlanSkillPrompt(rootDir: string, sourcePrd: string, planPath: string, skillContent: string): string {
  return `You are Ralphi's planning worker inside the repository at ${rootDir}.

Task:
- Read the source PRD at ${sourcePrd}.
- Create or overwrite the structured PRD plan at ${planPath}.
- Use the skill below as the primary workflow and schema guidance.

Constraints:
- Do not ask follow-up questions.
- Never ask the user for clarification. If details are missing, make the smallest reasonable assumption and continue.
- Do not modify application code.
- Read only ${sourcePrd} and the existing ${planPath} when it exists. Do not inspect unrelated repository files.
- The output must be valid JSON and follow the Ralph PRD format with branchName and userStories.
- Keep stories small enough for iterative implementation and backlog generation.
- Finish immediately after writing ${planPath}.

Selected skill: ralph
Skill instructions:
${skillContent}

Return a short confirmation after saving the structured plan.`;
}

function buildBacklogSkillPrompt(
  rootDir: string,
  sourcePrd: string,
  planPath: string,
  prdJsonPath: string,
  backlogPath: string,
  branchName: string,
  skillName: string,
  skillContent: string,
  hasExistingBacklog: boolean
): string {
  return `You are Ralphi's planning worker inside the repository at ${rootDir}.

Task:
- Read the source PRD at ${sourcePrd}.
- Read the structured PRD plan at ${planPath}.
- If ${prdJsonPath} exists, read it as supplemental structured context.
- Create or overwrite the backlog JSON file at ${backlogPath}.
- Use the skill below as the primary workflow.

Constraints:
- Do not ask follow-up questions.
- Never ask the user for clarification. If the PRD is ambiguous, infer the smallest reasonable backlog and continue.
- Do not modify application code.
- Read only ${sourcePrd}, ${planPath}, ${prdJsonPath}, and the existing ${backlogPath} when it exists. Do not inspect unrelated repository files.
- The output must be valid JSON, not markdown.
- Preserve or improve existing task detail when helpful, but the final file must reflect the current PRD.
- Set "sourcePrd" to ${sourcePrd}.
- Set "branchName" to ${branchName}.
- Use only these statuses: pending, in_progress, done, blocked, disabled.
- Set activeItemId and activeStepId to the first pending or in-progress work item when possible.
- Finish immediately after writing ${backlogPath}.

Backlog contract:
{
  "version": 1,
  "sourcePrd": "${sourcePrd}",
  "branchName": "${branchName}",
  "activeItemId": "BT-001" | null,
  "activeStepId": "ST-001-01" | null,
  "items": [
    {
      "id": "BT-001",
      "storyId": "US-001",
      "title": "Short task title",
      "description": "Short task description",
      "status": "pending",
      "notes": "",
      "updatedAt": "ISO-8601 timestamp",
      "source": "prd",
      "manualTitle": null,
      "manualDescription": null,
      "steps": [
        {
          "id": "ST-001-01",
          "title": "Acceptance criterion or checklist step",
          "status": "pending"
        }
      ]
    }
  ]
}

Existing backlog present: ${hasExistingBacklog ? 'yes' : 'no'}
Selected skill: ${skillName}
Skill instructions:
${skillContent}

Return a short confirmation after saving the backlog.`;
}

async function generateBacklogPlan(options: {
  rootDir: string;
  runDir: string;
  sourcePrd: string;
  provider: ProviderName;
  verbose?: boolean;
  onProgress?: (message: string) => void;
}): Promise<string> {
  const planPath = backlogPlanPath(options.runDir);

  if (await isJsonFile(options.sourcePrd)) {
    await copyFile(options.sourcePrd, planPath);
    options.onProgress?.('Preparing plan');
    return planPath;
  }

  const skillContent = await loadSkillFile(builtinSkillFile('ralph'));
  const previousMtime = (await stat(planPath).catch(() => null))?.mtimeMs ?? 0;
  let lastProgress = '';
  options.onProgress?.('Preparing plan');

  const result = await runProviderPrompt({
    provider: options.provider,
    workspaceDir: options.runDir,
    verbose: options.verbose,
    mode: 'planning',
    timeoutMs: 180000,
    onOutputLine: line => {
      const next = classifyOutputLine(line);
      if (next && next !== lastProgress) {
        lastProgress = next;
        options.onProgress?.(`Preparing plan · ${next}`);
      }
    },
    stopWhen: async () => {
      const fileStat = await stat(planPath).catch(() => null);
      if (!fileStat || fileStat.mtimeMs <= previousMtime) {
        return false;
      }

      return isJsonFile(planPath);
    },
    stopCheckIntervalMs: 1000,
    prompt: buildPlanSkillPrompt(options.rootDir, options.sourcePrd, planPath, skillContent)
  });

  if (result.exitCode !== 0) {
    const summary = summarizeProviderOutput(result.output);
    throw new Error(summary ? `Plan generation failed.\n${summary}` : 'Plan generation failed.');
  }

  if (!(await isJsonFile(planPath))) {
    throw new Error('The planning step did not produce a valid structured PRD plan.');
  }

  return planPath;
}

export async function runProviderPrompt(options: {
  provider: ProviderName;
  workspaceDir: string;
  prompt: string;
  verbose?: boolean;
  mode?: ProviderInvocationMode;
  timeoutMs?: number;
  onOutputLine?: (line: string) => void;
  stopWhen?: () => Promise<boolean>;
  stopCheckIntervalMs?: number;
}): Promise<ProviderPromptResult> {
  const executable = await findExecutable(providerExecutableName(options.provider));
  if (!executable) {
    throw new Error(`Provider "${options.provider}" was not found in PATH.`);
  }

  const invocation = buildProviderInvocation(
    options.provider,
    options.workspaceDir,
    options.verbose ?? false,
    options.mode ?? 'execution',
    'local'
  );

  return new Promise<ProviderPromptResult>((resolve, reject) => {
    const child = spawn(
      invocation.command,
      invocation.promptTransport === 'arg' ? [...invocation.args, options.prompt] : invocation.args,
      {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );

    let output = '';
    let pendingLine = '';
    let settled = false;
    let expectedEarlyExit = false;
    let stopCheckRunning = false;
    const timeoutMs = options.timeoutMs;
    const timeoutHandle =
      typeof timeoutMs === 'number' && timeoutMs > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            child.kill('SIGTERM');
            reject(new Error(`Provider "${options.provider}" timed out after ${Math.ceil(timeoutMs / 1000)}s.`));
          }, timeoutMs)
        : null;
    const stopCheckInterval =
      options.stopWhen
        ? setInterval(() => {
            if (settled || expectedEarlyExit || stopCheckRunning) {
              return;
            }

            stopCheckRunning = true;
            void options
              .stopWhen?.()
              .then(shouldStop => {
                if (!shouldStop || settled || expectedEarlyExit) {
                  return;
                }

                expectedEarlyExit = true;
                child.kill('SIGKILL');
              })
              .catch(() => undefined)
              .finally(() => {
                stopCheckRunning = false;
              });
          }, options.stopCheckIntervalMs ?? 1000)
        : null;

    const handleOutput = (chunk: Buffer): void => {
      const value = chunk.toString('utf8');
      output += value;
      pendingLine += value;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          options.onOutputLine?.(trimmed);
        }
      }
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);

    child.on('error', error => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (stopCheckInterval) {
        clearInterval(stopCheckInterval);
      }
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    child.on('close', code => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (stopCheckInterval) {
        clearInterval(stopCheckInterval);
      }
      if (settled) {
        return;
      }
      settled = true;
      const trailingLine = pendingLine.trim();
      if (trailingLine) {
        options.onOutputLine?.(trailingLine);
      }
      resolve({
        exitCode: expectedEarlyExit ? 0 : code ?? 1,
        output
      });
    });

    if (invocation.promptTransport === 'stdin') {
      child.stdin.end(options.prompt, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

export async function generateBacklogWithSkill(options: GenerateBacklogWithSkillOptions) {
  const paths = resolvePlanStatePaths(options.ralphDir, options.sourcePrd, sourceSlug(options.sourcePrd));
  await ensureDir(paths.runDir);

  const planPath = await generateBacklogPlan({
    rootDir: options.rootDir,
    runDir: paths.runDir,
    sourcePrd: options.sourcePrd,
    provider: options.provider,
    verbose: options.verbose,
    onProgress: options.onProgress
  });
  const skillContent = await loadSkillFile(options.skillFilePath);
  const hasExistingBacklog = await pathExists(paths.backlogPath);
  const existingBacklogMtime = hasExistingBacklog ? (await stat(paths.backlogPath).catch(() => null))?.mtimeMs ?? 0 : 0;
  const branchName =
    ((await pathExists(paths.prdJsonPath)) ? await extractJsonBranch(paths.prdJsonPath) : '') || deriveBranchName(options.sourcePrd);
  let lastProgress = '';
  options.onProgress?.('Preparing backlog');
  const result = await runProviderPrompt({
    provider: options.provider,
    workspaceDir: paths.runDir,
    verbose: options.verbose,
    mode: 'planning',
    timeoutMs: 180000,
    onOutputLine: line => {
      const next = classifyOutputLine(line);
      if (next && next !== lastProgress) {
        lastProgress = next;
        options.onProgress?.(next);
      }
    },
    stopWhen: async () => {
      const fileStat = await stat(paths.backlogPath).catch(() => null);
      if (!fileStat || fileStat.mtimeMs <= existingBacklogMtime) {
        return false;
      }

      return (await loadBacklog(paths.backlogPath)) !== null;
    },
    stopCheckIntervalMs: 1000,
    prompt: buildBacklogSkillPrompt(
      options.rootDir,
      options.sourcePrd,
      planPath,
      paths.prdJsonPath,
      paths.backlogPath,
      branchName,
      options.skillName,
      skillContent,
      hasExistingBacklog
    )
  });

  if (result.exitCode !== 0) {
    const summary = summarizeProviderOutput(result.output);
    throw new Error(summary ? `Backlog generation failed.\n${summary}` : 'Backlog generation failed.');
  }

  const backlog = await loadBacklog(paths.backlogPath);
  if (!backlog) {
    throw new Error('The selected skill did not produce a valid backlog.json file.');
  }

  await saveBacklogSnapshot(paths.backlogPath, options.sourcePrd, branchName, backlog);
  return backlog;
}

async function provisionExecutionSkills(config: RalphConfig, contexts: InternalContext[], reporter?: RalphReporter): Promise<void> {
  const selectedSkills = config.executionSkills.filter(skill => skill.provider === config.tool);
  const skillTarget = providerSkillTarget(config.tool);
  if (selectedSkills.length === 0 || !skillTarget) {
    return;
  }

  const provisionedByWorkspace = new Map<string, string[]>();
  for (const context of contexts) {
    const workspaceDir = context.snapshot.workspaceDir;
    const existing = provisionedByWorkspace.get(workspaceDir);
    if (existing) {
      context.provisionedSkillPaths = [...existing];
      continue;
    }

    const created: string[] = [];
    for (const skill of selectedSkills) {
      const targetDir = resolveSkillTargetDir(workspaceDir, 'project', skillTarget, skill.name);
      if (await pathExists(targetDir)) {
        continue;
      }

      const sourceSkillFile = path.join(skill.sourcePath, 'SKILL.md');
      if (!(await pathExists(sourceSkillFile))) {
        throw new Error(`Execution skill "${skill.name}" is unavailable at ${skill.sourcePath}.`);
      }

      if (path.resolve(skill.sourcePath) === path.resolve(targetDir)) {
        continue;
      }

      await ensureDir(path.dirname(targetDir));
      await cp(skill.sourcePath, targetDir, { recursive: true, force: true });
      created.push(targetDir);

      await emit(reporter, {
        type: 'boot-log',
        level: 'info',
        message: `${context.snapshot.title}: provisioned skill ${skill.name} in ${displayPath(targetDir, workspaceDir)}.`,
        contextIndex: context.snapshot.index
      });
    }

    provisionedByWorkspace.set(workspaceDir, created);
    context.provisionedSkillPaths = [...created];
  }
}

async function cleanupProvisionedSkills(context: InternalContext, reporter?: RalphReporter): Promise<void> {
  if (context.provisionedSkillPaths.length === 0) {
    return;
  }

  for (const targetDir of context.provisionedSkillPaths) {
    await rm(targetDir, { recursive: true, force: true });
    await emit(reporter, {
      type: 'boot-log',
      level: 'info',
      message: `${context.snapshot.title}: removed temporary skill ${displayPath(targetDir, context.snapshot.workspaceDir)}.`,
      contextIndex: context.snapshot.index
    });
  }

  context.provisionedSkillPaths = [];
}

async function cleanupRemainingProvisionedSkills(contexts: InternalContext[], reporter?: RalphReporter): Promise<void> {
  for (const context of contexts) {
    await cleanupProvisionedSkills(context, reporter).catch(() => undefined);
  }
}

async function executeProviderIteration(
  config: RalphConfig,
  promptPath: string,
  logPath: string,
  context: InternalContext,
  reporter?: RalphReporter
): Promise<ProviderExecutionResult> {
  const providerTimeoutMs = 30 * 60 * 1000;

  if (config.executionEnvironment === 'devcontainer' && !context.devcontainerReady) {
    await emit(reporter, {
      type: 'boot-log',
      level: 'info',
      message: `${context.snapshot.title}: preparing devcontainer runtime.`,
      contextIndex: context.snapshot.index
    });
    await ensureDevcontainerWorkspace(context.snapshot.workspaceDir);
    context.devcontainerReady = true;
  }

  const invocation = buildProviderInvocation(config.tool, context.snapshot.workspaceDir, config.verbose, 'execution', config.executionEnvironment);
  const startTime = Date.now();
  const logStream = createWriteStream(logPath, { flags: 'w' });
  let lineCount = 0;
  let sawComplete = false;
  let currentStep = 'Starting agent';
  let exitCode = 0;
  let rawOutput = '';
  let pendingLine = '';
  let linesSinceCheckpoint = 0;
  let lastCheckpointAt = Date.now();
  let timedOut = false;
  let launchError: string | null = null;
  let mcpServers: RalphContextSnapshot['mcpServers'] = [];

  const promptInput = invocation.promptTransport === 'arg' ? await readFile(promptPath, 'utf8') : null;

  await new Promise<void>(resolve => {
    const pendingTasks: Array<Promise<unknown>> = [];
    const child = spawn(
      invocation.command,
      invocation.promptTransport === 'arg' ? [...invocation.args, promptInput ?? ''] : invocation.args,
      {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }

      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, 2000).unref();
    }, providerTimeoutMs);

    if (invocation.promptTransport === 'stdin') {
      const promptStream = createReadStream(promptPath);
      promptStream.pipe(child.stdin);
    } else {
      child.stdin.end();
    }

    const scheduleCheckpoint = (force = false): void => {
      linesSinceCheckpoint += 1;
      const now = Date.now();
      if (!force && linesSinceCheckpoint < 20 && now - lastCheckpointAt < 2000) {
        return;
      }

      lastCheckpointAt = now;
      linesSinceCheckpoint = 0;
      pendingTasks.push(saveContextCheckpoint({ ...context.snapshot }).catch(() => undefined));
    };

    const handleLine = (line: string): void => {
      if (!line) {
        return;
      }

      lineCount += 1;
      if (line.includes('<promise>COMPLETE</promise>')) {
        sawComplete = true;
      }

      const mcpSignal = parseMcpServerSignal(line);
      if (mcpSignal) {
        mcpServers = mergeMcpServerSignal(mcpServers, mcpSignal);
        context.snapshot.mcpServers = mcpServers;
      }

      const marker = extractBacklogMarker(line);
      if (marker) {
        const backlog = applyBacklogMarker(context.snapshot.backlog, marker);
        if (backlog) {
          context.snapshot.backlog = backlog;
          context.snapshot.backlogProgress = backlogProgressLabel(backlog);
          context.snapshot.activeBacklogItemId = marker.itemId ?? backlog.activeItemId;
          context.snapshot.activeBacklogStepId = marker.stepId ?? backlog.activeStepId;
          pendingTasks.push(
            saveBacklogSnapshot(
              context.snapshot.backlogPath,
              context.snapshot.sourcePrd,
              context.snapshot.branchName ?? path.basename(context.snapshot.sourcePrd),
              backlog
            ).catch(() => undefined)
          );
          pendingTasks.push(
            emit(reporter, {
              type: 'backlog-update',
              contextIndex: context.snapshot.index,
              backlog,
              itemId: context.snapshot.activeBacklogItemId,
              stepId: context.snapshot.activeBacklogStepId
            })
          );
          scheduleCheckpoint(true);
        }
      }

      currentStep = classifyOutputLine(line);
      context.snapshot.lastStep = currentStep;
      pendingTasks.push(
        emit(reporter, {
          type: 'iteration-output',
          contextIndex: context.snapshot.index,
          line,
          step: currentStep
        })
      );
      scheduleCheckpoint();
    };

    const forwardChunk = (chunk: Buffer, writeRaw?: (value: string) => void): void => {
      const value = chunk.toString('utf8');
      rawOutput += value;
      logStream.write(value);
      writeRaw?.(value);

      pendingLine += value;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? '';
      for (const line of lines) {
        handleLine(line.trim());
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      forwardChunk(chunk, config.verbose ? value => process.stdout.write(value) : undefined);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      forwardChunk(chunk, config.verbose ? value => process.stderr.write(value) : undefined);
    });

    child.on('error', error => {
      launchError = error.message;
      clearTimeout(timeoutHandle);
      logStream.end();
      exitCode = 1;
      settled = true;
      pendingTasks.push(saveContextCheckpoint({ ...context.snapshot }).catch(() => undefined));
      void Promise.allSettled(pendingTasks).then(() => resolve());
    });
    child.on('close', code => {
      clearTimeout(timeoutHandle);
      if (settled) {
        return;
      }

      settled = true;
      logStream.end();
      if (pendingLine.trim()) {
        handleLine(pendingLine.trim());
      }
      exitCode = timedOut ? 124 : code ?? 1;
      sawComplete = sawComplete || rawOutput.includes('<promise>COMPLETE</promise>');
      pendingTasks.push(saveContextCheckpoint({ ...context.snapshot }).catch(() => undefined));
      void Promise.allSettled(pendingTasks).then(() => resolve());
    });
  });

  return {
    durationMs: Date.now() - startTime,
    exitCode,
    lineCount,
    sawComplete,
    step: currentStep,
    usageTotals: extractUsageTotalsFromOutput(rawOutput),
    rawOutput,
    timedOut,
    launchError,
    mcpServers
  };
}

async function refreshContext(context: InternalContext): Promise<void> {
  context.snapshot.storyProgress = await storyProgressLabel(context.snapshot.prdJsonPath);
  context.snapshot.backlog = await refreshBacklog(
    context.snapshot.sourcePrd,
    context.snapshot.prdJsonPath,
    context.snapshot.backlogPath
  ).catch(() => context.snapshot.backlog);
  context.snapshot.backlogProgress = backlogProgressLabel(context.snapshot.backlog);
  context.snapshot.activeBacklogItemId = context.snapshot.backlog?.activeItemId ?? null;
  context.snapshot.activeBacklogStepId = context.snapshot.backlog?.activeStepId ?? null;
  context.snapshot.done = await isContextPersistedStateComplete(context.snapshot.prdJsonPath, context.snapshot.backlog);
}

function nextIterationAttempt(context: InternalContext, iteration: number): number {
  return (
    context.snapshot.iterationHistory.filter(entry => entry.iteration === iteration).length + 1
  );
}

async function runIteration(
  config: RalphConfig,
  context: InternalContext,
  contexts: InternalContext[],
  reporter: RalphReporter | undefined,
  preparedWorkspace: PreparedWorkspace,
  prdIteration: number,
  trackLabel: string,
  totalContexts: number
): Promise<void> {
  const { tmpDir } = workspaceDirs(config.ralphDir);
  const attempt = nextIterationAttempt(context, prdIteration);
  const promptTempPath = path.join(tmpDir, `prompt.${context.snapshot.runSlug}.${randomUUID()}.md`);
  const promptArtifacts = resolvePromptArtifactPaths(context.snapshot.runDir, prdIteration, attempt);
  const logPath = path.join(
    context.snapshot.logDir,
    `iteration-${String(prdIteration).padStart(3, '0')}-attempt-${String(attempt).padStart(2, '0')}.log`
  );
  const retryCount = context.snapshot.lastFailure?.retryCount ?? 0;
  const footprintBefore = await captureWorkspaceFootprint(context.snapshot.workspaceDir).catch<WorkspaceFootprint>(() => ({
    repository: false,
    entries: {}
  }));

  context.snapshot.lastLogPath = logPath;
  context.snapshot.status = 'running';
  context.snapshot.lastStep = 'Preparing prompt';
  context.snapshot.lastError = null;
  context.snapshot.lastFailure = null;
  await saveContextCheckpoint({ ...context.snapshot });

  const startedAt = Date.now();
  let result: ProviderExecutionResult = {
    durationMs: 0,
    exitCode: 1,
    lineCount: 0,
    sawComplete: false,
    step: 'Preparing prompt',
    usageTotals: null,
    rawOutput: '',
    timedOut: false,
    launchError: null,
    mcpServers: []
  };
  let failureMessage: string | null = null;

  try {
    const dependencyContext = findContextByPlanId(contexts, context.snapshot.dependsOnPlanId);
    const promptBundle = await buildPromptBundle({
      rootDir: config.rootDir,
      ralphDir: config.ralphDir,
      tool: config.tool,
      sourcePrd: context.snapshot.sourcePrd,
      runDir: context.snapshot.runDir,
      prdJsonPath: context.snapshot.prdJsonPath,
      progressFilePath: context.snapshot.progressFilePath,
      backlogPath: context.snapshot.backlogPath,
      workspaceDir: context.snapshot.workspaceDir,
      branchName: context.snapshot.branchName,
      baseRef: context.snapshot.baseRef,
      dependsOnTitle: dependencyContext?.snapshot.title ?? context.snapshot.dependsOnTitle ?? null,
      dependsOnSourcePrd: dependencyContext?.snapshot.sourcePrd ?? null,
      dependsOnBranch: dependencyContext?.snapshot.branchName ?? null,
      iteration: prdIteration,
      totalIterations: context.snapshot.iterationsTarget,
      scheduleMode: config.schedule,
      trackLabel,
      prdPosition: context.snapshot.index + 1,
      prdTotal: totalContexts,
      skillRegistry: preparedWorkspace.skillRegistry,
      skillRegistryPath: preparedWorkspace.skillRegistryPath,
      skillRegistrySources: preparedWorkspace.skillRegistrySources
    });

    await persistPromptBundle(promptArtifacts, promptBundle);
    await writeFile(promptTempPath, promptBundle.prompt, 'utf8');

    context.snapshot.lastPromptPath = promptArtifacts.promptPath;
    context.snapshot.lastPromptPreviewPath = promptArtifacts.previewPath;
    context.snapshot.lastPromptSourcesPath = promptArtifacts.sourcesPath;
    context.snapshot.lastStep = 'Starting agent';
    await saveContextCheckpoint({ ...context.snapshot });

    await emit(reporter, {
      type: 'iteration-start',
      context: { ...context.snapshot },
      prdIteration,
      trackLabel,
      phaseLabel: trackLabel
    });

    result = await executeProviderIteration(config, promptTempPath, logPath, context, reporter);
    context.snapshot.iterationsRun = prdIteration;
    context.snapshot.lastLogPath = logPath;
    context.snapshot.lastPromptPath = promptArtifacts.promptPath;
    context.snapshot.lastPromptPreviewPath = promptArtifacts.previewPath;
    context.snapshot.lastPromptSourcesPath = promptArtifacts.sourcesPath;
    context.snapshot.mcpServers = result.mcpServers;
    context.snapshot.usageTotals = mergeUsageTotals(context.snapshot.usageTotals, result.usageTotals);

    try {
      await refreshContext(context);
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : 'Unable to refresh the persisted PRD/backlog state.';
    }

    if (!failureMessage && result.exitCode !== 0) {
      const outputSummary = summarizeProviderOutput(result.rawOutput);
      failureMessage =
        result.launchError ??
        (result.timedOut
          ? `Provider timed out after ${Math.ceil((30 * 60 * 1000) / 1000)}s.`
          : outputSummary || `Provider exited with code ${result.exitCode}.`);
    }
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : 'Iteration setup failed.';
    result = {
      ...result,
      durationMs: Date.now() - startedAt,
      step: context.snapshot.lastStep,
      launchError: failureMessage
    };
    await writeFile(logPath, `${failureMessage}\n`, 'utf8').catch(() => undefined);
  }

  const footprintAfter = await captureWorkspaceFootprint(context.snapshot.workspaceDir).catch<WorkspaceFootprint>(() => ({
    repository: false,
    entries: {}
  }));
  const touchedFiles = summarizeTouchedFiles(footprintBefore, footprintAfter, extractTouchedFileHints(result.rawOutput));
  const failure = failureMessage
    ? classifyFailure({
        message: failureMessage,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        launchError: Boolean(result.launchError),
        rawLogPath: logPath,
        mcpServers: result.mcpServers,
        retryCount
      })
    : null;

  context.snapshot.iterationsRun = prdIteration;
  context.snapshot.lastLogPath = logPath;
  context.snapshot.lastFailure = failure;
  context.snapshot.lastError = failure?.summary ?? null;

  if (failure) {
    context.snapshot.done = false;
    context.snapshot.status = 'blocked';
  } else if (context.snapshot.done) {
    context.snapshot.done = true;
    context.snapshot.status = 'complete';
  } else {
    context.snapshot.status = 'queued';
  }

  if (!failure && result.sawComplete && !context.snapshot.done) {
    await emit(reporter, {
      type: 'boot-log',
      level: 'warning',
      message: `${context.snapshot.title}: provider reported completion, but stories or backlog items are still pending.`,
      contextIndex: context.snapshot.index
    });
  }

  context.snapshot.iterationHistory = [
    ...context.snapshot.iterationHistory,
    {
      iteration: prdIteration,
      attempt,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      lineCount: result.lineCount,
      lastStep: result.step,
      logPath,
      promptPath: promptArtifacts.promptPath,
      promptPreviewPath: promptArtifacts.previewPath,
      promptSourcesPath: promptArtifacts.sourcesPath,
      touchedFiles,
      usageTotals: result.usageTotals,
      mcpServers: result.mcpServers,
      failure,
      completed: context.snapshot.done
    }
  ];

  await emit(reporter, {
    type: 'backlog-update',
    contextIndex: context.snapshot.index,
    backlog: context.snapshot.backlog ?? {
      items: [],
      totalItems: 0,
      completedItems: 0,
      totalSteps: 0,
      completedSteps: 0,
      activeItemId: null,
      activeStepId: null
    },
    itemId: context.snapshot.activeBacklogItemId,
    stepId: context.snapshot.activeBacklogStepId
  });

  await emit(reporter, {
    type: 'iteration-finish',
    context: { ...context.snapshot },
    prdIteration,
    trackLabel,
    step: result.step,
    logPath,
    durationMs: result.durationMs,
    lineCount: result.lineCount,
    exitCode: result.exitCode,
    completed: context.snapshot.done
  });

  await saveContextCheckpoint({ ...context.snapshot });
  await saveRunSession(config.ralphDir, config, runSessionStatus(contexts));

  await unlink(promptTempPath).catch(() => undefined);
}

async function runRoundRobin(
  config: RalphConfig,
  contexts: InternalContext[],
  reporter: RalphReporter | undefined,
  preparedWorkspace: PreparedWorkspace
): Promise<void> {
  const orderedContexts = orderContextsByDependency(contexts);
  const totalWaves = Math.max(...orderedContexts.map(context => context.snapshot.iterationsTarget), 0);

  for (let wave = 1; wave <= totalWaves; wave += 1) {
    if (orderedContexts.every(context => context.snapshot.done || context.snapshot.iterationsRun >= context.snapshot.iterationsTarget)) {
      return;
    }

    await emit(reporter, {
      type: 'wave-start',
      wave,
      totalWaves
    });

    for (const context of orderedContexts) {
      if (context.snapshot.done || context.snapshot.iterationsRun >= context.snapshot.iterationsTarget) {
        continue;
      }

      if (!dependencyReady(config, context, contexts)) {
        await markContextWaitingForDependency(context, contexts, reporter);
        continue;
      }

      await ensureContextExecutionReady(config, context, contexts, reporter);
      await emit(reporter, {
        type: 'track-start',
        contextIndex: context.snapshot.index,
        totalContexts: contexts.length,
        sourcePrd: context.snapshot.sourcePrd
      });

      const prdIteration = context.snapshot.iterationsRun + 1;
      await runIteration(
        config,
        context,
        contexts,
        reporter,
        preparedWorkspace,
        prdIteration,
        `Wave ${wave}/${totalWaves} | PRD ${context.snapshot.index + 1}/${contexts.length}`,
        contexts.length
      );
      await finalizeContextArtifacts(config, context, reporter);
      await saveRunSession(config.ralphDir, config, runSessionStatus(contexts));
    }
  }
}

async function runPerPrd(
  config: RalphConfig,
  contexts: InternalContext[],
  reporter: RalphReporter | undefined,
  preparedWorkspace: PreparedWorkspace
): Promise<void> {
  const orderedContexts = orderContextsByDependency(contexts);

  for (const context of orderedContexts) {
    if (!dependencyReady(config, context, contexts)) {
      await markContextWaitingForDependency(context, contexts, reporter);
      continue;
    }

    await emit(reporter, {
      type: 'track-start',
      contextIndex: context.snapshot.index,
      totalContexts: contexts.length,
      sourcePrd: context.snapshot.sourcePrd
    });

    while (!context.snapshot.done && context.snapshot.iterationsRun < context.snapshot.iterationsTarget) {
      if (!dependencyReady(config, context, contexts)) {
        await markContextWaitingForDependency(context, contexts, reporter);
        break;
      }

      await ensureContextExecutionReady(config, context, contexts, reporter);
      const prdIteration = context.snapshot.iterationsRun + 1;
      await runIteration(
        config,
        context,
        contexts,
        reporter,
        preparedWorkspace,
        prdIteration,
        `PRD ${context.snapshot.index + 1}/${contexts.length} | Pass ${prdIteration}/${context.snapshot.iterationsTarget}`,
        contexts.length
      );
      await finalizeContextArtifacts(config, context, reporter);
      await saveRunSession(config.ralphDir, config, runSessionStatus(contexts));
    }
  }
}

async function runParallel(
  config: RalphConfig,
  contexts: InternalContext[],
  reporter: RalphReporter | undefined,
  preparedWorkspace: PreparedWorkspace
): Promise<void> {
  const orderedContexts = orderContextsByDependency(contexts);

  await Promise.all(
    orderedContexts.map(async context => {
      await emit(reporter, {
        type: 'track-start',
        contextIndex: context.snapshot.index,
        totalContexts: contexts.length,
        sourcePrd: context.snapshot.sourcePrd
      });

      while (!context.snapshot.done && context.snapshot.iterationsRun < context.snapshot.iterationsTarget) {
        if (!dependencyReady(config, context, contexts)) {
          await markContextWaitingForDependency(context, contexts, reporter);
          await delay(250);
          continue;
        }

        await ensureContextExecutionReady(config, context, contexts, reporter);
        const prdIteration = context.snapshot.iterationsRun + 1;
        await runIteration(
          config,
          context,
          contexts,
          reporter,
          preparedWorkspace,
          prdIteration,
          `Parallel agent ${context.snapshot.index + 1}/${contexts.length} | Pass ${prdIteration}/${context.snapshot.iterationsTarget}`,
          contexts.length
        );
        await finalizeContextArtifacts(config, context, reporter);
        await saveRunSession(config.ralphDir, config, runSessionStatus(contexts));
      }
    })
  );
}

async function bootProject(config: RalphConfig, reporter?: RalphReporter): Promise<void> {
  const missingChecks = await Promise.all(
    config.projectConfig.skills.map(async skill => {
      const targetDir = resolveSkillTargetDir(config.rootDir, skill.scope, skill.target, skill.name);
      return (await pathExists(targetDir)) ? 0 : 1;
    })
  );
  const missingSkillCount = missingChecks.reduce<number>((sum, value) => sum + value, 0);

  await emit(reporter, {
    type: 'project-config',
    configPath: config.projectConfigPath,
    created: config.projectConfigCreated,
    missingSkillCount: typeof missingSkillCount === 'number' ? missingSkillCount : 0
  });

  if (config.projectConfig.skills.length === 0) {
    return;
  }

  await emit(reporter, {
    type: 'skill-sync-start',
    total: config.projectConfig.skills.length
  });

  await syncProjectSkills(config.rootDir, config.projectConfig, async progress => {
    await emit(reporter, {
      type: 'skill-sync-progress',
      current: progress.current,
      total: progress.total,
      skill: progress.spec,
      targetDir: progress.targetDir
    });
  });

  await emit(reporter, {
    type: 'skill-sync-finish',
    total: config.projectConfig.skills.length
  });
}

async function applyGitPreflight(
  config: RalphConfig,
  contexts: InternalContext[],
  reporter?: RalphReporter
): Promise<void> {
  const validation = await inspectGitWorkspace(config.rootDir);
  await emit(reporter, {
    type: 'git-validation',
    validation
  });

  for (const warning of validation.warnings) {
    await emit(reporter, {
      type: 'boot-log',
      level: 'warning',
      message: warning
    });
  }

  for (const context of contexts) {
    context.snapshot.workspaceDir = config.rootDir;
    context.snapshot.status = context.snapshot.done ? 'complete' : 'queued';
  }
}

async function prepareContexts(config: RalphConfig, reporter?: RalphReporter): Promise<InternalContext[]> {
  validatePlanDependencies(config.plans);
  const pendingSession = await loadPendingRunSession(config.ralphDir);
  const resumeFromCheckpoint = shouldResumePendingRun(config, pendingSession?.config ?? null);
  const contexts = await Promise.all(config.plans.map((plan, index) => createContext(config, plan, index, resumeFromCheckpoint)));
  await bootProject(config, reporter);
  await applyGitPreflight(config, contexts, reporter);

  for (const context of contexts) {
    context.snapshot.backlog = await ensureBacklog(
      context.snapshot.sourcePrd,
      context.snapshot.prdJsonPath,
      context.snapshot.backlogPath
    ).catch(() => context.snapshot.backlog);
    context.snapshot.backlogProgress = backlogProgressLabel(context.snapshot.backlog);
    context.snapshot.activeBacklogItemId = context.snapshot.backlog?.activeItemId ?? null;
    context.snapshot.activeBacklogStepId = context.snapshot.backlog?.activeStepId ?? null;
  }

  await Promise.all(contexts.map(context => saveContextCheckpoint({ ...context.snapshot })));
  await saveRunSession(config.ralphDir, config, runSessionStatus(contexts));

  return contexts;
}

async function finalizeCompletedContexts(config: RalphConfig, contexts: InternalContext[], reporter?: RalphReporter): Promise<void> {
  for (const context of contexts) {
    await finalizeContextArtifacts(config, context, reporter);
  }
}

export async function validateProvider(config: RalphConfig): Promise<void> {
  const executable = await findExecutable(providerExecutableName(config.tool));
  if (!executable) {
    throw new Error(`Provider "${config.tool}" was not found in PATH.`);
  }

  if (config.executionEnvironment === 'devcontainer') {
    if (!config.devcontainerConfigPath) {
      throw new Error('Devcontainer execution was selected, but no devcontainer.json file was found in this project.');
    }

    if (!(await findDevcontainerExecutable())) {
      throw new Error('Devcontainer execution was selected, but the `devcontainer` CLI was not found in PATH.');
    }
  }
}

export async function scanPrdDirectory(rootDir: string): Promise<string[]> {
  for (const prdDir of resolvePrdDirCandidates(rootDir)) {
    if (!(await pathExists(prdDir))) {
      continue;
    }

    const dirents = await readdir(prdDir, { withFileTypes: true });
    const fileEntries = dirents.filter(entry => entry.isFile() && /\.(md|json|txt)$/i.test(entry.name) && !entry.name.startsWith('.'));
    if (fileEntries.length === 0) {
      continue;
    }

    const rankedFiles: Array<{ filePath: string; createdAtMs: number }> = [];

    // Batch stat calls so large PRD directories do not fan out thousands of fs requests at once.
    for (let index = 0; index < fileEntries.length; index += 64) {
      const batch = fileEntries.slice(index, index + 64);
      const resolvedBatch = await Promise.all(
        batch.map(async entry => {
          const filePath = path.join(prdDir, entry.name);
          const fileStat = await stat(filePath);
          return {
            filePath,
            createdAtMs: fileStat.birthtimeMs > 0 ? fileStat.birthtimeMs : fileStat.ctimeMs
          };
        })
      );

      rankedFiles.push(...resolvedBatch);
    }

    return rankedFiles
      .sort((left, right) => right.createdAtMs - left.createdAtMs || left.filePath.localeCompare(right.filePath))
      .map(item => item.filePath);
  }

  return [];
}

export async function resolvePrdFiles(rootDir: string, rawInput: string | undefined, cwd: string): Promise<string[]> {
  if (!rawInput) {
    const fallbacks = [path.join(projectRalphiDir(rootDir), 'prd.json'), path.join(rootDir, 'ralph', 'prd.json')];

    for (const fallback of fallbacks) {
      if (await pathExists(fallback)) {
        return [fallback];
      }
    }

    return [];
  }

  const values = splitCommaList(rawInput).map(item => (path.isAbsolute(item) ? item : path.resolve(cwd, item)));

  for (const value of values) {
    if (!(await pathExists(value))) {
      throw new Error(`PRD file not found: ${displayPath(value, rootDir)}`);
    }
  }

  return values;
}

export async function buildPlansFromPrds(
  prdFiles: string[],
  defaultIterations: number,
  perPrdIterations: number[] = []
): Promise<RalphPrdPlan[]> {
  const iterations = ensureArrayLength(perPrdIterations, prdFiles.length, defaultIterations);

  return Promise.all(
    prdFiles.map(async (sourcePrd, index) => {
      const branchName = (await isJsonFile(sourcePrd)) ? await extractJsonBranch(sourcePrd) : '';
      return {
        id: sourceSlug(sourcePrd),
        stateKey: sourceSlug(sourcePrd),
        variantIndex: null,
        variantCount: null,
        title: path.basename(sourcePrd).replace(/\.[^.]+$/, ''),
        sourcePrd,
        iterations: iterations[index],
        branchName: branchName || deriveBranchName(sourcePrd),
        dependsOn: null,
        baseRef: null,
        worktreePath: null,
        backlogPath: null,
        resetBacklog: false
      };
    })
  );
}

export async function runRalphi(config: RalphConfig, reporter?: RalphReporter): Promise<RalphRunSummary> {
  let preparedWorkspace: Awaited<ReturnType<typeof ensureWorkspace>> | null = null;
  let contexts: InternalContext[] = [];

  try {
    const doctorReport = await runDoctor(config);
    await emit(reporter, {
      type: 'doctor-report',
      report: doctorReport
    });
    if (doctorReport.status === 'blocking') {
      throw new Error(`Preflight checks failed. ${doctorReport.checks.filter(check => check.status === 'blocking').map(check => check.summary).join(' ')}`);
    }

    await validateProvider(config);
    preparedWorkspace = await ensureWorkspace(config);
    contexts = await prepareContexts(config, reporter);
    await finalizeCompletedContexts(config, contexts, reporter);
    await saveRunSession(config.ralphDir, config, runSessionStatus(contexts));

    await emit(reporter, {
      type: 'prepared',
      contexts: contexts.map(context => ({ ...context.snapshot }))
    });
    await sendLifecycleNotifications(config, reporter, {
      event: 'start',
      rootDir: config.rootDir,
      provider: config.tool,
      schedule: config.schedule,
      contexts: contexts.map(context => ({ ...context.snapshot }))
    });

    if (config.schedule === 'parallel') {
      await runParallel(config, contexts, reporter, preparedWorkspace);
    } else if (config.schedule === 'per-prd') {
      await runPerPrd(config, contexts, reporter, preparedWorkspace);
    } else {
      await runRoundRobin(config, contexts, reporter, preparedWorkspace);
    }

    await finalizeCompletedContexts(config, contexts, reporter);
    let finalBranchName: string | null = null;
    if (contexts.length > 1 && contexts.every(context => context.snapshot.done)) {
      finalBranchName = await createFinalMergedBranch(config, contexts, reporter);
      if (finalBranchName) {
        await cleanupExecutionBranches(config, contexts, reporter);
      }
    }
    await cleanupRemainingProvisionedSkills(contexts, reporter);

    for (const context of contexts) {
      if (context.snapshot.done) {
        context.snapshot.status = 'complete';
      } else if (context.snapshot.iterationsRun >= context.snapshot.iterationsTarget) {
        context.snapshot.status = context.snapshot.lastError ? 'blocked' : 'queued';
      }
    }

    const summary: RalphRunSummary = {
      completed: contexts.every(context => context.snapshot.done) && (contexts.length <= 1 || Boolean(finalBranchName)),
      tool: config.tool,
      schedule: config.schedule,
      maxIterations: Math.max(...contexts.map(context => context.snapshot.iterationsTarget), 0),
      usageTotals: aggregateUsageTotals(contexts.map(context => context.snapshot.usageTotals)),
      finalBranchName,
      contexts: contexts.map(context => ({ ...context.snapshot }))
    };

    await Promise.all(contexts.map(context => saveContextCheckpoint({ ...context.snapshot }).catch(() => undefined)));
    await saveRunSession(config.ralphDir, config, summary.completed ? 'complete' : 'blocked', summary);

    await emit(reporter, {
      type: 'summary',
      summary
    });
    await sendLifecycleNotifications(config, reporter, {
      event: summary.completed ? 'success' : 'failure',
      rootDir: config.rootDir,
      provider: config.tool,
      schedule: config.schedule,
      contexts: summary.contexts,
      summary
    });

    return summary;
  } catch (error) {
    await sendLifecycleNotifications(config, reporter, {
      event: 'failure',
      rootDir: config.rootDir,
      provider: config.tool,
      schedule: config.schedule,
      contexts: contexts.map(context => ({ ...context.snapshot })),
      errorMessage: error instanceof Error ? error.message : String(error)
    }).catch(() => undefined);
    throw error;
  } finally {
    if (preparedWorkspace) {
      await unlink(preparedWorkspace.skillRegistryPath).catch(() => undefined);
    }
  }
}

export async function createPrdDraftFromBrief(
  rootDir: string,
  briefOrInput: string | PrdDraftInput,
  options: CreatePrdDraftOptions = {}
): Promise<string> {
  const prdDir = resolvePrimaryPrdDir(rootDir);
  await ensureDir(prdDir);

  const normalizedInput: PrdDraftInput =
    typeof briefOrInput === 'string'
      ? {
          title: briefOrInput.trim(),
          description: briefOrInput.trim()
        }
      : {
          title: briefOrInput.title.trim(),
          description: briefOrInput.description.trim()
        };

  const slug = slugify(normalizedInput.title || normalizedInput.description || 'prd');
  let targetPath = path.join(prdDir, `prd-${slug}.md`);
  let suffix = 2;

  while (await pathExists(targetPath)) {
    targetPath = path.join(prdDir, `prd-${slug}-${suffix}.md`);
    suffix += 1;
  }

  if (options.skillFilePath && options.provider) {
    const skillContent = await loadSkillFile(options.skillFilePath);
    let lastProgress = '';
    const result = await runProviderPrompt({
      provider: options.provider,
      workspaceDir: prdDir,
      verbose: options.verbose,
      mode: 'planning',
      timeoutMs: 180000,
      onOutputLine: line => {
        const next = classifyOutputLine(line);
        if (next && next !== lastProgress) {
          lastProgress = next;
          options.onProgress?.(next);
        }
      },
      prompt: buildPrdSkillPrompt(rootDir, targetPath, normalizedInput, options.skillName ?? 'custom skill', skillContent)
    });

    if (result.exitCode !== 0) {
      const summary = summarizeProviderOutput(result.output);
      throw new Error(summary ? `PRD generation failed.\n${summary}` : 'PRD generation failed.');
    }

    if (!(await pathExists(targetPath))) {
      throw new Error('The selected skill did not create the PRD file.');
    }
  } else {
    const skillBanner = options.skillName?.trim() ? `<!-- Seeded with Ralphi skill: ${options.skillName.trim()} -->` : '';
    await writeFile(targetPath, renderPrdMarkdown(normalizedInput, skillBanner), 'utf8');
  }

  const paths = resolvePlanStatePaths(projectRalphiDir(rootDir), targetPath);
  await ensureDir(paths.runDir);
  return targetPath;
}

export function parsePerPrdIterations(rawValue: string | undefined): number[] {
  return parsePositiveIntegerList(rawValue);
}
