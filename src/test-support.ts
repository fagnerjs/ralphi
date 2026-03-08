import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import type {
  BacklogSnapshot,
  RalphConfig,
  RalphContextSnapshot,
  RalphPrdPlan,
  RalphRunSummary,
  RalphUsageTotals,
  RalphiProjectConfig
} from './core/types.js';
import { defaultNotificationSettings } from './core/notifications.js';
import { projectRalphiDir } from './core/project.js';
import { sourceSlug, writeJsonFile } from './core/utils.js';

const now = '2026-03-07T00:00:00.000Z';

export async function createTempProject(prefix = 'ralphi-test-'): Promise<{
  rootDir: string;
  ralphDir: string;
  cleanup: () => Promise<void>;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const ralphDir = projectRalphiDir(rootDir);
  await mkdir(path.join(rootDir, 'docs', 'prds'), { recursive: true });
  await mkdir(ralphDir, { recursive: true });
  await writeJsonFile(path.join(rootDir, 'package.json'), {
    name: 'ralphi-fixture',
    version: '1.0.0',
    type: 'module'
  });

  return {
    rootDir,
    ralphDir,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    }
  };
}

export async function writeExecutable(binDir: string, name: string, body = '#!/usr/bin/env bash\nexit 0\n'): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const targetPath = path.join(binDir, name);
  await writeFile(targetPath, body, 'utf8');
  await chmod(targetPath, 0o755);
  return targetPath;
}

export function makeProjectConfig(overrides: Partial<RalphiProjectConfig> = {}): RalphiProjectConfig {
  return {
    version: 1,
    defaults: {
      tool: 'codex',
      schedule: 'round-robin',
      verbose: false,
      workspaceStrategy: 'worktree',
      iterations: 4,
      environment: 'local',
      ...(overrides.defaults ?? {})
    },
    notifications: overrides.notifications ?? defaultNotificationSettings(),
    skills: overrides.skills ?? []
  };
}

export function makePlan(sourcePrd: string, overrides: Partial<RalphPrdPlan> = {}): RalphPrdPlan {
  const slug = overrides.stateKey ?? sourceSlug(sourcePrd);
  return {
    id: overrides.id ?? slug,
    stateKey: slug,
    variantIndex: overrides.variantIndex ?? null,
    variantCount: overrides.variantCount ?? null,
    title: overrides.title ?? path.basename(sourcePrd).replace(/\.[^.]+$/, ''),
    sourcePrd,
    iterations: overrides.iterations ?? 4,
    branchName: overrides.branchName ?? `feature/${path.basename(sourcePrd).replace(/\.[^.]+$/, '')}`,
    dependsOn: overrides.dependsOn ?? null,
    baseRef: overrides.baseRef ?? null,
    worktreePath: overrides.worktreePath ?? null,
    backlogPath: overrides.backlogPath ?? null,
    resetBacklog: overrides.resetBacklog ?? false
  };
}

export function makeBacklogSnapshot(overrides: Partial<BacklogSnapshot> = {}): BacklogSnapshot {
  const items =
    overrides.items ??
    [
      {
        id: 'BT-001',
        storyId: 'US-001',
        title: 'Deliver the first slice',
        description: 'Ship the first task.',
        status: 'pending' as const,
        notes: '',
        steps: [
          {
            id: 'ST-001-01',
            title: 'Implement the first slice',
            status: 'pending' as const
          }
        ],
        updatedAt: now,
        source: 'prd' as const,
        manualTitle: null,
        manualDescription: null
      }
    ];

  return {
    items,
    totalItems: overrides.totalItems ?? items.filter(item => item.status !== 'disabled').length,
    completedItems: overrides.completedItems ?? items.filter(item => item.status === 'done').length,
    totalSteps:
      overrides.totalSteps ??
      items.flatMap(item => item.steps).filter(step => step.status !== 'disabled').length,
    completedSteps:
      overrides.completedSteps ??
      items.flatMap(item => item.steps).filter(step => step.status === 'done').length,
    activeItemId: overrides.activeItemId ?? items[0]?.id ?? null,
    activeStepId: overrides.activeStepId ?? items[0]?.steps[0]?.id ?? null
  };
}

export function makeUsageTotals(overrides: Partial<RalphUsageTotals> = {}): RalphUsageTotals {
  return {
    inputTokens: overrides.inputTokens ?? 1200,
    cachedInputTokens: overrides.cachedInputTokens ?? 100,
    outputTokens: overrides.outputTokens ?? 320,
    reasoningOutputTokens: overrides.reasoningOutputTokens ?? null,
    totalTokens: overrides.totalTokens ?? 1620,
    totalCostUsd: overrides.totalCostUsd ?? 0.42,
    currency: overrides.currency ?? 'USD'
  };
}

export function makeConfig(rootDir: string, overrides: Partial<RalphConfig> = {}): RalphConfig {
  const ralphDir = overrides.ralphDir ?? projectRalphiDir(rootDir);
  const defaultPlan =
    overrides.plans?.[0] ??
    makePlan(path.join(rootDir, 'docs', 'prds', 'sample-prd.md'));

  return {
    rootDir,
    ralphDir,
    tool: overrides.tool ?? 'codex',
    executionSkills: overrides.executionSkills ?? [],
    plans: overrides.plans ?? [defaultPlan],
    maxIterations: overrides.maxIterations ?? defaultPlan.iterations,
    schedule: overrides.schedule ?? 'round-robin',
    verbose: overrides.verbose ?? false,
    workspaceStrategy: overrides.workspaceStrategy ?? 'worktree',
    executionEnvironment: overrides.executionEnvironment ?? 'local',
    devcontainerConfigPath: overrides.devcontainerConfigPath ?? null,
    launchMode: overrides.launchMode ?? 'run-existing',
    createPrdPrompt: overrides.createPrdPrompt,
    projectConfigPath: overrides.projectConfigPath ?? path.join(rootDir, '.ralphi.json'),
    projectConfig: overrides.projectConfig ?? makeProjectConfig(),
    projectConfigCreated: overrides.projectConfigCreated ?? false,
    projectContextMode: overrides.projectContextMode ?? 'contextual'
  };
}

export function makeContextSnapshot(config: RalphConfig, overrides: Partial<RalphContextSnapshot> = {}): RalphContextSnapshot {
  const plan = overrides.sourcePrd
    ? makePlan(overrides.sourcePrd, {
        title: overrides.title,
        iterations: overrides.iterationsTarget,
        branchName: overrides.branchName,
        stateKey: overrides.runSlug
      })
    : config.plans[0] ?? makePlan(path.join(config.rootDir, 'docs', 'prds', 'sample-prd.md'));
  const runSlug = overrides.runSlug ?? plan.stateKey;
  const runDir = overrides.runDir ?? path.join(config.ralphDir, 'state', runSlug);
  const backlog = overrides.backlog ?? makeBacklogSnapshot();

  return {
    index: overrides.index ?? 0,
    planId: overrides.planId ?? plan.id,
    sourcePrd: overrides.sourcePrd ?? plan.sourcePrd,
    sourceLabel: overrides.sourceLabel ?? path.basename(plan.sourcePrd),
    title: overrides.title ?? plan.title,
    dependsOnPlanId: overrides.dependsOnPlanId ?? plan.dependsOn ?? null,
    dependsOnTitle: overrides.dependsOnTitle ?? null,
    runSlug,
    runDir,
    logDir: overrides.logDir ?? path.join(runDir, 'logs'),
    prdJsonPath: overrides.prdJsonPath ?? path.join(runDir, 'prd.json'),
    progressFilePath: overrides.progressFilePath ?? path.join(runDir, 'progress.txt'),
    backlogPath: overrides.backlogPath ?? path.join(runDir, 'backlog.json'),
    workspaceDir: overrides.workspaceDir ?? config.rootDir,
    branchName: overrides.branchName ?? plan.branchName,
    baseRef: overrides.baseRef ?? null,
    worktreePath: overrides.worktreePath ?? null,
    worktreeRemoved: overrides.worktreeRemoved ?? false,
    branchRemoved: overrides.branchRemoved ?? false,
    storyProgress: overrides.storyProgress ?? '0/1 stories complete',
    backlogProgress: overrides.backlogProgress ?? '0/1 tasks · 0/1 steps',
    backlog,
    status: overrides.status ?? 'queued',
    done: overrides.done ?? false,
    iterationsRun: overrides.iterationsRun ?? 0,
    iterationsTarget: overrides.iterationsTarget ?? plan.iterations,
    lastLogPath: overrides.lastLogPath ?? null,
    activeBacklogItemId: overrides.activeBacklogItemId ?? backlog.activeItemId,
    activeBacklogStepId: overrides.activeBacklogStepId ?? backlog.activeStepId,
    commitSha: overrides.commitSha ?? null,
    commitMessage: overrides.commitMessage ?? null,
    usageTotals: overrides.usageTotals ?? null,
    lastStep: overrides.lastStep ?? 'Preparing workspace',
    lastError: overrides.lastError ?? null,
    lastFailure: overrides.lastFailure ?? null,
    iterationHistory: overrides.iterationHistory ?? [],
    lastPromptPath: overrides.lastPromptPath ?? null,
    lastPromptPreviewPath: overrides.lastPromptPreviewPath ?? null,
    lastPromptSourcesPath: overrides.lastPromptSourcesPath ?? null,
    mcpServers: overrides.mcpServers ?? []
  };
}

export function makeRunSummary(contexts: RalphContextSnapshot[], overrides: Partial<RalphRunSummary> = {}): RalphRunSummary {
  return {
    completed: overrides.completed ?? contexts.every(context => context.done),
    tool: overrides.tool ?? 'codex',
    schedule: overrides.schedule ?? 'round-robin',
    maxIterations: overrides.maxIterations ?? Math.max(...contexts.map(context => context.iterationsTarget), 0),
    usageTotals: overrides.usageTotals ?? null,
    finalBranchName: overrides.finalBranchName ?? null,
    contexts: overrides.contexts ?? contexts
  };
}
