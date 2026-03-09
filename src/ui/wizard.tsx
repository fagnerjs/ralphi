import { unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import React, { useEffect, useMemo, useState } from 'react';
import { Box, render, Text, useApp, useInput } from 'ink';
import { ProgressBar, Spinner, ThemeProvider } from '@inkjs/ui';

import {
  addBacklogItem,
  editBacklogItem,
  ensureBacklog,
  loadBacklog,
  regenerateBacklog,
  removeBacklogItem,
  saveBacklogSnapshot,
  setBacklogItemStatus
} from '../core/backlog.js';
import {
  applyProjectBootstrap,
  inspectProjectBootstrap,
  type ProjectBootstrapInspection,
  type ProjectBootstrapItem
} from '../core/bootstrap.js';
import {
  listClaudeCatalog,
  listOpenAiCatalog,
  previewCatalogSkill,
  previewGitHubSkill,
  type CatalogSkillEntry,
  type CatalogSkillPreview
} from '../core/catalog.js';
import { sortPlansByDependencies, validatePlanDependencies, wouldCreateDependencyCycle } from '../core/dependencies.js';
import { doctorSummaryLine, runDoctor } from '../core/doctor.js';
import { cleanupManagedWorktrees, type WorktreeCleanupResult } from '../core/git.js';
import { loadPrdDocument, savePrdDocument } from '../core/prd.js';
import {
  addProjectSkill,
  buildExecutionSkills,
  globalProviderSkillDir,
  installSkill,
  installLocalSkill,
  listBuiltinSkills,
  listInstalledSkills,
  providerSkillTarget,
  projectProviderSkillDir,
  resolveSkillTargetDir,
  saveProjectConfig
} from '../core/project.js';
import { notificationChannelLabel, notificationChannelOptions, notificationChannelUrlHint, notificationEventOptions, normalizeNotificationSettings } from '../core/notifications.js';
import { evaluateResumeDrift } from '../core/resume.js';
import { createPrdDraftFromBrief, generateBacklogWithSkill, resolvePlanStatePaths } from '../core/runtime.js';
import { clearRunState, listCheckpointSnapshots, loadPendingRunSession } from '../core/session.js';
import { builtinSkillFile, discoverSkills, loadSkillFile, type DiscoveredSkill } from '../core/skills.js';
import type {
  BacklogSnapshot,
  BacklogStatus,
  DoctorReport,
  ExecutionEnvironment,
  NotificationChannel,
  NotificationEventPreferences,
  ProjectContextMode,
  ProviderName,
  RalphConfig,
  RalphContextSnapshot,
  RalphExecutionSkill,
  RalphPrdPlan,
  RalphiRunSession,
  ResumeDriftReport,
  ScheduleMode,
  SkillInstallSpec,
  SkillInstallTarget
} from '../core/types.js';
import {
  basenameWithoutExt,
  deriveBranchName,
  displayPath,
  displayPathFromHome,
  ensureDir,
  isPrintableInput,
  parseRepoPathInput,
  pathExists,
  pickScheduleLabel,
  sourceSlug,
  truncateEnd,
  truncateMiddle
} from '../core/utils.js';
import { ArcadeCabinet } from './arcade.js';
import { AsciiLogo, ChoiceRow, HintLine, LabelValue, SectionPanel, SelectRow, SystemTabs, WindowFrame } from './components.js';
import { useTerminalViewport } from './terminal.js';
import { palette, systemTheme } from './theme.js';

type HomeAction = 'run-existing' | 'create-prd' | 'bootstrap' | 'notifications' | 'manage-skills' | 'cleanup' | 'about';
type SkillCatalogSource = 'openai' | 'claude' | 'github';
type PendingRunAction = 'continue' | 'restart' | 'discard';
type NotificationMenuAction = 'events' | 'channels';
type Screen =
  | 'resume-run'
  | 'bootstrap'
  | 'bootstrap-view'
  | 'home'
  | 'about'
  | 'notifications'
  | 'notification-events'
  | 'notification-channels'
  | 'notification-edit'
  | 'cleanup-confirm'
  | 'prds'
  | 'brief'
  | 'skill-mode'
  | 'skill-directory'
  | 'backlog-policy'
  | 'brief-created'
  | 'backlog'
  | 'dependencies'
  | 'backlog-edit'
  | 'backlog-view'
  | 'prd-view'
  | 'prd-edit'
  | 'provider'
  | 'provider-skills'
  | 'provider-skill-action'
  | 'environment'
  | 'schedule'
  | 'iterations'
  | 'token-budget'
  | 'review'
  | 'skills-menu'
  | 'skill-catalog'
  | 'skill-view'
  | 'skill-input'
  | 'skill-target'
  | 'skill-scope'
  | 'skill-progress';

interface WizardProps {
  rootDir: string;
  ralphDir: string;
  prdOptions: string[];
  initial: RalphConfig;
}

interface InstalledSkillView {
  builtin: Array<{ name: string; targetDir: string; description: string }>;
  project: Array<SkillInstallSpec & { targetDir: string; description: string }>;
  global: Array<SkillInstallSpec & { targetDir: string; description: string }>;
}

interface CreatedDraft {
  path: string;
  title: string;
  prdSkillName: string;
  backlogSkillName: string;
}

type EditorField = 'title' | 'description';
type SkillPurpose = 'prd' | 'backlog';
type BacklogPolicyMode = 'reuse' | 'regenerate';

interface DraftFormState {
  title: string;
  description: string;
  field: EditorField;
  fullscreen: boolean;
}

interface SkillPickerState {
  purpose: SkillPurpose;
  context: 'create' | 'existing';
}

interface BacklogPolicyRow {
  prdPath: string;
  hasExisting: boolean;
  mode: BacklogPolicyMode;
}

interface BacklogBatchProgress {
  total: number;
  completed: number;
  currentIndex: number;
  currentPrdPath: string;
  mode: BacklogPolicyMode;
  step: string;
  history: string[];
}

interface ViewerState {
  kind: 'prd' | 'backlog' | 'skill' | 'bootstrap';
  title: string;
  subtitle: string;
  lines: string[];
  scroll: number;
  returnScreen: 'backlog' | 'review' | 'skill-catalog' | 'skill-input' | 'provider-skills' | 'bootstrap';
}

interface PrdEditorState {
  prdPath: string;
  title: string;
  description: string;
  field: EditorField;
  fullscreen: boolean;
  returnScreen: 'backlog' | 'review';
}

interface BacklogEditorState {
  mode: 'add' | 'edit';
  prdPath: string;
  itemId: string | null;
  title: string;
  description: string;
  field: EditorField;
  fullscreen: boolean;
  returnScreen: 'backlog' | 'review';
}

interface BacklogRow {
  kind: 'prd' | 'item' | 'action';
  prdPath: string;
  itemId: string | null;
  label: string;
  detail: string;
  description: string;
  status: BacklogStatus | null;
}

interface DependencyRow {
  prdPath: string;
  label: string;
  detail: string;
  description: string;
}

interface IterationEntry {
  kind: 'variant-count' | 'plan';
  key: string;
  label: string;
  detail: string;
}

interface SkillInstallProgress {
  total: number;
  current: number;
  currentLabel: string;
  history: string[];
}

interface ProviderSkillRow {
  kind: 'section' | 'skill';
  id: string;
  label: string;
  detail: string;
  skill: DiscoveredSkill | null;
  checked: boolean;
  selectedByDefault: boolean;
}

interface ProviderSkillDecisionState {
  skill: DiscoveredSkill;
}

interface PendingRunState {
  session: RalphiRunSession;
  checkpoints: RalphContextSnapshot[];
  driftReport: ResumeDriftReport;
}

type NotificationEventKey = keyof NotificationEventPreferences;

interface NotificationMenuOption {
  value: NotificationMenuAction;
  label: string;
  description: string;
}

interface NotificationEventRow {
  id: string;
  label: string;
  detail: string;
  checked: boolean;
  event: NotificationEventKey;
}

interface NotificationChannelRow {
  id: string;
  label: string;
  detail: string;
  checked: boolean;
  channel: NotificationChannel;
  configured: boolean;
}

export function screenBlocksCharacterShortcuts(screen: string): boolean {
  return (
    screen === 'brief' ||
    screen === 'prd-edit' ||
    screen === 'backlog-edit' ||
    screen === 'skill-input' ||
    screen === 'notification-edit' ||
    screen === 'cleanup-confirm'
  );
}

const providerOptions: Array<{ value: ProviderName; description: string }> = [
  { value: 'amp', description: 'Legacy Ralph-compatible autonomous loop.' },
  { value: 'claude', description: 'Claude Code autonomous sessions with native .claude skills.' },
  { value: 'codex', description: 'Codex exec with fresh context per PRD pass and .codex skills.' },
  { value: 'copilot', description: 'GitHub Copilot CLI with .github instructions, agents, and .github/skills.' },
  { value: 'cursor', description: 'Cursor Agent CLI sessions guided by AGENTS.md plus .cursor/rules.' },
  { value: 'gemini', description: 'Gemini CLI sessions driven by GEMINI.md and .gemini commands.' },
  { value: 'opencode', description: 'OpenCode runs with AGENTS.md plus .opencode agents, commands, and skills.' },
  { value: 'qwen', description: 'Qwen Code sessions with .qwen settings, commands, and skills.' }
];

const scheduleOptions: Array<{ value: ScheduleMode; description: string }> = [
  { value: 'round-robin', description: 'Run one pass on each PRD before the next wave.' },
  { value: 'per-prd', description: 'Finish one PRD before moving to the next.' },
  { value: 'parallel', description: 'Run isolated worktrees in parallel. Single-PRD runs can fan out into multiple variants.' }
];

const baseHomeOptions: Array<{ value: HomeAction; label: string; description: string }> = [
  {
    value: 'run-existing',
    label: 'Run existing PRDs',
    description: 'Pick PRDs, review backlogs, and launch.'
  },
  {
    value: 'create-prd',
    label: 'Create new PRDs',
    description: 'Write a brief, generate a PRD backlog, and continue.'
  },
  {
    value: 'notifications',
    label: 'Notifications',
    description: 'Configure webhooks in .ralphi.json.'
  },
  { value: 'manage-skills', label: 'Manage skills', description: 'Install or review skills.' },
  {
    value: 'cleanup',
    label: 'Cleanup Ralphi worktrees',
    description: 'Remove Ralphi-managed worktrees and branches.'
  },
  { value: 'about', label: 'About', description: 'Read the overview and runtime model.' }
];

const aboutHighlights = [
  'Ralphi is a terminal control deck for PRD-driven agent execution.',
  'It can orchestrate amp, claude, codex, copilot, cursor, gemini, opencode, or qwen across one or many PRDs.',
  'Each pass is a fresh provider process so checkpoints, logs, and recovery stay clean.'
];

const aboutRuntimeLines = [
  'Keeps shared run state in `./.ralphi/state`, archives snapshots in `./.ralphi/archive`, and refreshes backlog state before launch.',
  'Supports round-robin, per-PRD, and parallel worktree execution.',
  'Loads built-in, project, and provider-native skills without hiding where they come from.'
];

const pendingRunOptions: Array<{ value: PendingRunAction; label: string; description: string }> = [
  {
    value: 'continue',
    label: 'Continue from checkpoint',
    description: 'Resume the unfinished execution from the latest checkpoint saved in .ralphi/state.'
  },
  {
    value: 'restart',
    label: 'Restart from scratch',
    description: 'Clear the saved state and launch the same execution again from the beginning.'
  },
  {
    value: 'discard',
    label: 'Discard saved state',
    description: 'Delete the unfinished execution state and return to the normal launch menu.'
  }
];

const briefCreatedOptions = [
  { value: 'create-another', label: 'Create another PRD', description: 'Keep drafting additional PRDs before moving on to backlog review.' },
  { value: 'continue', label: 'Review backlogs and continue', description: 'Inspect the generated backlog, then continue to runtime setup.' }
] as const;

const skillMenuOptions: Array<{ value: SkillCatalogSource | 'back'; label: string; description: string }> = [
  { value: 'openai', label: 'Browse OpenAI skills', description: 'List the official OpenAI system and curated skill catalogs.' },
  { value: 'claude', label: 'Browse Claude skills', description: 'List the official Anthropic skills repository.' },
  { value: 'github', label: 'Install from GitHub repo', description: 'Add a custom skill from a GitHub repository path or URL.' },
  { value: 'back', label: 'Back', description: 'Return to the launch menu.' }
];

const scopeOptions: Array<{ value: 'project' | 'global'; description: string }> = [
  { value: 'project', description: 'Install into this repository and track the dependency in .ralphi.json.' },
  { value: 'global', description: 'Install into the selected provider global skill directory.' }
];

const skillTargetOptions: Array<{ value: SkillInstallTarget; label: string; description: string }> = [
  { value: 'codex', label: 'Codex', description: 'Install into the official OpenAI skill directories.' },
  { value: 'claude', label: 'Claude', description: 'Install into the official Claude skill directories.' },
  { value: 'copilot', label: 'Copilot', description: 'Install into the standard .github/skills and ~/.copilot/skills directories.' },
  { value: 'amp', label: 'Amp', description: 'Install into the legacy .agents skill directories.' },
  { value: 'opencode', label: 'OpenCode', description: 'Install into the standard .opencode skill directories.' },
  { value: 'qwen', label: 'Qwen', description: 'Install into the standard .qwen skill directories.' }
];

const notificationMenuOptions: NotificationMenuOption[] = [
  {
    value: 'events',
    label: 'Process events',
    description: 'Choose which lifecycle events should emit notifications.'
  },
  {
    value: 'channels',
    label: 'Destinations',
    description: 'Configure webhook destinations like Slack, Teams, Discord, and more.'
  }
];

const environmentOptions: Array<{ value: ExecutionEnvironment; label: string; description: string }> = [
  { value: 'local', label: 'Local machine', description: 'Run providers directly on the current machine.' },
  { value: 'devcontainer', label: 'Devcontainer', description: 'Run providers through the project dev container when it is available.' }
];

const skillModeOptions = [
  { value: 'builtin', label: 'Use Ralphi skill' },
  { value: 'directory', label: 'Choose from skill directories' }
] as const;

const providerSkillDecisionOptions = [
  {
    value: 'session',
    label: 'Use this run only',
    description: 'Provision the skill natively for this execution without changing .ralphi.json.'
  },
  {
    value: 'default',
    label: 'Make default',
    description: 'Track the skill in .ralphi.json and keep a project copy when needed.'
  }
] as const;

function nextWindowStart(currentStart: number, cursor: number, totalItems: number, visibleRows: number): number {
  if (totalItems <= visibleRows) {
    return 0;
  }

  const maxStart = Math.max(0, totalItems - visibleRows);
  const normalizedStart = Math.max(0, Math.min(currentStart, maxStart));

  if (cursor < normalizedStart) {
    return cursor;
  }

  if (cursor >= normalizedStart + visibleRows) {
    return Math.max(0, cursor - visibleRows + 1);
  }

  return normalizedStart;
}

function sliceWindow<T>(items: T[], start: number, visibleRows: number): { start: number; values: T[] } {
  const clampedStart = Math.max(0, Math.min(start, Math.max(0, items.length - visibleRows)));
  return {
    start: clampedStart,
    values: items.slice(clampedStart, clampedStart + visibleRows)
  };
}

function variantIterationKey(sourcePrd: string, variantIndex: number): string {
  return `variant:${sourcePrd}:${variantIndex}`;
}

function buildPlans(
  ralphDir: string,
  selectedPrds: string[],
  iterationValues: Record<string, string>,
  schedule: ScheduleMode,
  singlePrdVariantCount: number,
  dependencyValues: Record<string, string | null>
): RalphPrdPlan[] {
  if (selectedPrds.length === 1 && schedule === 'parallel') {
    const sourcePrd = selectedPrds[0];
    const baseStateKey = sourceSlug(sourcePrd);
    const variantCount = Math.max(2, singlePrdVariantCount);

    return Array.from({ length: variantCount }, (_, index) => {
      const variantIndex = index + 1;
      const stateKey = `${baseStateKey}-v${variantIndex}`;
      const paths = resolvePlanStatePaths(ralphDir, sourcePrd, stateKey);
      return {
        id: stateKey,
        stateKey,
        variantIndex,
        variantCount,
        title: `${basenameWithoutExt(sourcePrd)} · v${variantIndex}`,
        sourcePrd,
        iterations: Math.max(1, Number(iterationValues[variantIterationKey(sourcePrd, variantIndex)] ?? '5') || 5),
        branchName: `${deriveBranchName(sourcePrd)}/v${variantIndex}`,
        dependsOn: null,
        baseRef: null,
        worktreePath: null,
        backlogPath: paths.backlogPath,
        resetBacklog: false
      };
    });
  }

  return selectedPrds.map(sourcePrd => {
    const stateKey = sourceSlug(sourcePrd);
    const paths = resolvePlanStatePaths(ralphDir, sourcePrd, stateKey);
    const dependencySourcePrd = dependencyValues[sourcePrd] ?? null;
    return {
      id: stateKey,
      stateKey,
      variantIndex: null,
      variantCount: null,
      title: basenameWithoutExt(sourcePrd),
      sourcePrd,
      iterations: Math.max(1, Number(iterationValues[sourcePrd] ?? '5') || 5),
      branchName: deriveBranchName(sourcePrd),
      dependsOn: dependencySourcePrd ? sourceSlug(dependencySourcePrd) : null,
      baseRef: null,
      worktreePath: null,
      backlogPath: paths.backlogPath,
      resetBacklog: false
    };
  });
}

function buildDependencyRows(selectedPrds: string[], dependencyValues: Record<string, string | null>): DependencyRow[] {
  return selectedPrds.map(prdPath => {
    const dependencyPath = dependencyValues[prdPath] ?? null;
    return {
      prdPath,
      label: path.basename(prdPath),
      detail: dependencyPath ? path.basename(dependencyPath) : 'starts immediately',
      description: dependencyPath
        ? `Waits for ${path.basename(dependencyPath)} before the agent can start.`
        : 'Can start as soon as the execution begins.'
    };
  });
}

function buildBacklogRows(prdPaths: string[], backlogByPrd: Record<string, BacklogSnapshot | null>): BacklogRow[] {

  return prdPaths.flatMap(prdPath => {
    const backlog = backlogByPrd[prdPath];
    const parent: BacklogRow = {
      kind: 'prd',
      prdPath,
      itemId: null,
      label: path.basename(prdPath),
      detail: backlog ? `${backlog.completedItems}/${backlog.totalItems} tasks` : 'backlog pending',
      description: displayPath(prdPath, path.dirname(prdPath)),
      status: null
    };

    const children = (backlog?.items ?? []).map(item => ({
      kind: 'item' as const,
      prdPath,
      itemId: item.id,
      label: `  ${item.title}`,
      detail: item.status.replace('_', ' '),
      description: item.description || item.steps[0]?.title || 'No description available.',
      status: item.status
    }));

    const actions: BacklogRow[] = backlog
      ? [
          {
            kind: 'action',
            prdPath,
            itemId: null,
            label: '  ↻ Regenerate backlog',
            detail: '',
            description: 'Delete the current backlog and create a fresh one from the PRD.',
            status: null
          }
        ]
      : [];

    return [parent, ...children, ...actions];
  });
}

function buildIterationEntries(
  selectedPrds: string[],
  schedule: ScheduleMode,
  singlePrdVariantCount: number,
  iterationValues: Record<string, string>
): IterationEntry[] {
  if (selectedPrds.length === 1 && schedule === 'parallel') {
    const sourcePrd = selectedPrds[0];
    const variantCount = Math.max(2, singlePrdVariantCount);
    return [
      {
        kind: 'variant-count',
        key: '__variants__',
        label: 'Parallel versions',
        detail: `${variantCount}x`
      },
      ...Array.from({ length: variantCount }, (_, index) => {
        const variantIndex = index + 1;
        const key = variantIterationKey(sourcePrd, variantIndex);
        return {
          kind: 'plan' as const,
          key,
          label: `Version ${variantIndex}`,
          detail: `${iterationValues[key] ?? '5'} passes`
        };
      })
    ];
  }

  return selectedPrds.map(prdPath => ({
    kind: 'plan' as const,
    key: prdPath,
    label: path.basename(prdPath),
    detail: `${iterationValues[prdPath] ?? '5'} passes`
  }));
}

function contextLabel(mode: ProjectContextMode): string {
  return mode === 'contextual' ? 'Contextual' : 'Global';
}

function statusLabel(status: BacklogStatus): string {
  if (status === 'in_progress') {
    return 'in progress';
  }

  return status;
}

function busyStateCopy(message: string): { title: string; detail: string } {
  const normalized = message.trim().toLowerCase();

  if (normalized.includes('backlog')) {
    return {
      title: 'Preparing backlog',
      detail: 'Ralphi is reading the selected PRD, syncing structured context, and writing backlog.json.'
    };
  }

  if (normalized.includes('prd')) {
    return {
      title: 'Preparing PRD',
      detail: 'Ralphi is generating the draft PRD so backlog creation can continue right after this step.'
    };
  }

  return {
    title: 'Working',
    detail: 'Ralphi is processing the current step. Keyboard input stays locked until the operation finishes.'
  };
}

function buildCatalogPreviewLines(preview: CatalogSkillPreview): string[] {
  const providerTargetLabel =
    preview.entry.source === 'github'
      ? 'Choose during install'
      : preview.entry.target === 'claude'
        ? 'Claude'
        : 'Codex';

  return [
    `Catalog: ${preview.entry.catalogLabel}`,
    `Repository: ${preview.entry.repo}`,
    `Path: ${preview.entry.path}`,
    `Provider target: ${providerTargetLabel}`,
    '',
    'Requirements',
    ...preview.requirements.map(entry => `- ${entry}`),
    '',
    'Files',
    ...preview.files.map(file => `- ${file}`),
    '',
    'SKILL.md',
    ...preview.content.split('\n')
  ];
}

function buildCatalogInstallSpec(entry: CatalogSkillEntry): SkillInstallSpec {
  return {
    id: entry.id,
    name: entry.name,
    scope: 'project',
    source: entry.source,
    target: entry.target,
    repo: entry.repo,
    path: entry.path,
    ref: entry.ref,
    description: entry.description
  };
}

function buildGitHubInstallSpec(rawValue: string, target: SkillInstallTarget): SkillInstallSpec {
  const parsed = parseRepoPathInput(rawValue);
  return {
    id: `github:${parsed.repo}:${parsed.path}:${target}`,
    name: parsed.path.split('/').pop() ?? 'custom-skill',
    scope: 'project',
    source: 'github',
    target,
    repo: parsed.repo,
    path: parsed.path,
    ref: parsed.ref
  };
}

function skillInstallProgressValue(progress: SkillInstallProgress): number {
  if (progress.total <= 0) {
    return 0;
  }

  const inFlightWeight = progress.current < progress.total ? 0.4 : 0;
  return Math.min(100, Math.round(((progress.current + inFlightWeight) / progress.total) * 100));
}

function scopeDescriptionForTarget(rootDir: string, scope: 'project' | 'global', target: SkillInstallTarget): string {
  const skillDir = resolveSkillTargetDir(rootDir, scope, target, '__skill__').replace(`${path.sep}__skill__`, '');
  return scope === 'project'
    ? `Install into ${displayPath(skillDir, rootDir)} and track the dependency in .ralphi.json.`
    : `Install into ${displayPathFromHome(skillDir, os.homedir())} so it is available across projects.`;
}

function backlogBatchProgressValue(progress: BacklogBatchProgress): number {
  if (progress.total <= 0) {
    return 0;
  }

  const inFlightWeight = progress.completed < progress.total ? 0.4 : 0;
  return Math.min(100, Math.round(((progress.completed + inFlightWeight) / progress.total) * 100));
}

function backlogBatchTitle(progress: BacklogBatchProgress): string {
  return progress.total === 1 ? 'Preparing backlog' : 'Preparing backlogs';
}

function backlogBatchDetail(progress: BacklogBatchProgress): string {
  const action = progress.mode === 'reuse' ? 'Reusing' : 'Generating';
  return `${action} ${path.basename(progress.currentPrdPath)} · ${progress.step}`;
}

function pendingRunSummaryRows(pendingRun: PendingRunState): string[] {
  const checkpointsByPlan = new Map(pendingRun.checkpoints.map(checkpoint => [checkpoint.planId, checkpoint] as const));

  return pendingRun.session.config.plans.map(plan => {
    const checkpoint = checkpointsByPlan.get(plan.id);
    if (!checkpoint) {
      return `${path.basename(plan.sourcePrd)} · waiting for the first checkpoint`;
    }

    const state = checkpoint.done ? 'done' : checkpoint.lastError ? 'blocked' : checkpoint.status;
    const progress = checkpoint.backlogProgress || checkpoint.storyProgress || 'no progress yet';
    return `${path.basename(plan.sourcePrd)} · ${state} · ${progress}`;
  });
}

function buildNotificationEventRows(settings: RalphConfig['projectConfig']['notifications']): NotificationEventRow[] {
  const normalized = normalizeNotificationSettings(settings);

  return notificationEventOptions.map(option => ({
    id: `event:${option.value}`,
    label: option.label,
    detail: option.description,
    checked: normalized.events[option.value],
    event: option.value
  }));
}

function buildNotificationChannelRows(settings: RalphConfig['projectConfig']['notifications']): NotificationChannelRow[] {
  const normalized = normalizeNotificationSettings(settings);

  return notificationChannelOptions.map(option => {
    const channelConfig = normalized.channels[option.value];
    const configured = Boolean(channelConfig?.url);
    const status = configured ? (channelConfig?.enabled ? 'configured · enabled' : 'configured · disabled') : 'not configured';

    return {
      id: `channel:${option.value}`,
      label: option.label,
      detail: `${status} · ${option.description}`,
      checked: Boolean(channelConfig?.enabled && channelConfig.url),
      channel: option.value,
      configured
    };
  });
}

function resumeClassificationLabel(report: ResumeDriftReport): string {
  switch (report.classification) {
    case 'safe_resume':
      return 'Safe';
    case 'warn_resume':
      return 'Warning';
    default:
      return 'Restart required';
  }
}

function doctorCheckRows(report: DoctorReport): string[] {
  return report.checks.map(check => `[${check.status}] ${check.label} :: ${check.summary}`);
}

function skillLabel(skill: DiscoveredSkill | null): string {
  return skill ? skill.name : 'Not selected';
}

function skillDetail(skill: DiscoveredSkill): string {
  return `${skill.label} · ${truncateEnd(skill.description, 66)}`;
}

function normalizeSkillPath(targetPath: string): string {
  return path.resolve(targetPath);
}

function providerSkillSourceDir(skill: DiscoveredSkill): string {
  return path.dirname(skill.filePath);
}

function providerSkillStateId(provider: ProviderName, skill: DiscoveredSkill): string {
  return `execution:${provider}:${skill.id}`;
}

function providerSupportsNativeExecutionSkills(provider: ProviderName): boolean {
  return providerSkillTarget(provider) !== null;
}

function providerProjectSkillRoots(rootDir: string, provider: ProviderName): string[] {
  switch (provider) {
    case 'amp':
      return [path.join(rootDir, '.agents', 'skills')];
    case 'claude':
      return [path.join(rootDir, '.claude', 'skills')];
    case 'codex':
      return [path.join(rootDir, '.codex', 'skills', 'public')];
    case 'copilot':
      return [path.join(rootDir, '.github', 'skills')];
    case 'cursor':
    case 'gemini':
      return [];
    case 'opencode':
      return [path.join(rootDir, '.opencode', 'skills')];
    case 'qwen':
      return [path.join(rootDir, '.qwen', 'skills')];
  }
}

function providerGlobalSkillRoots(provider: ProviderName): string[] {
  switch (provider) {
    case 'amp':
      return [path.join(os.homedir(), '.config', 'agents', 'skills')];
    case 'claude':
      return [path.join(os.homedir(), '.claude', 'skills')];
    case 'codex':
      return [path.join(os.homedir(), '.codex', 'skills', 'public')];
    case 'copilot':
      return [path.join(os.homedir(), '.copilot', 'skills')];
    case 'cursor':
    case 'gemini':
      return [];
    case 'opencode':
      return [path.join(os.homedir(), '.config', 'opencode', 'skills')];
    case 'qwen':
      return [path.join(os.homedir(), '.qwen', 'skills')];
  }
}

function providerStructureLines(provider: ProviderName): string[] {
  switch (provider) {
    case 'amp':
      return [
        'Project skills: ./.agents/skills',
        'Global skills: ~/.config/agents/skills',
        'Shared instructions: AGENTS.md'
      ];
    case 'claude':
      return [
        'Primary memory: CLAUDE.md',
        'Project skills: ./.claude/skills',
        'Global skills: ~/.claude/skills'
      ];
    case 'codex':
      return [
        'Shared instructions: AGENTS.md',
        'Project skills: ./.codex/skills/public',
        'Global skills: ~/.codex/skills/public'
      ];
    case 'copilot':
      return [
        'Project instructions: ./.github/copilot-instructions.md',
        'Project instructions and skills: ./.github/instructions · ./.github/agents · ./.github/skills',
        'Global skills: ~/.copilot/skills'
      ];
    case 'cursor':
      return [
        'Shared instructions: AGENTS.md',
        'Project rules: ./.cursor/rules/*.mdc',
        'Cursor can also use the legacy ./.cursorrules file when present'
      ];
    case 'gemini':
      return [
        'Project instructions: ./GEMINI.md',
        'Project commands: ./.gemini/commands',
        'Global config: ~/.gemini/settings.json'
      ];
    case 'opencode':
      return [
        'Shared instructions: AGENTS.md',
        'Project config and dirs: ./opencode.json · ./.opencode/agents · ./.opencode/commands · ./.opencode/skills',
        'Global config: ~/.config/opencode/opencode.json'
      ];
    case 'qwen':
      return [
        'Project config: ./.qwen/settings.json',
        'Project commands and skills: ./.qwen/commands · ./.qwen/skills',
        'Global config: ~/.qwen/settings.json'
      ];
  }
}

function pathWithin(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathWithinAny(targetPath: string, roots: string[]): boolean {
  return roots.some(root => pathWithin(targetPath, root));
}

function buildSessionExecutionSkill(provider: ProviderName, skill: DiscoveredSkill): RalphExecutionSkill {
  return {
    id: providerSkillStateId(provider, skill),
    name: skill.name,
    provider,
    sourcePath: providerSkillSourceDir(skill),
    description: skill.description,
    persisted: false
  };
}

function buildLocalProjectSkillSpec(rootDir: string, provider: ProviderName, skill: DiscoveredSkill): SkillInstallSpec {
  const target = providerSkillTarget(provider);
  if (!target) {
    throw new Error(`${provider} uses its own native project structure instead of SKILL.md directories.`);
  }

  const targetDir = resolveSkillTargetDir(rootDir, 'project', target, skill.name);
  const relativePath = path.relative(rootDir, targetDir).split(path.sep).join('/');

  return {
    id: `local:${target}:${skill.name}`,
    name: skill.name,
    scope: 'project',
    source: 'local',
    target,
    path: relativePath,
    description: skill.description
  };
}

function nextProviderSkillCursor(rows: ProviderSkillRow[], cursor: number, direction: -1 | 1): number {
  if (rows.length === 0) {
    return 0;
  }

  let index = cursor;
  while (true) {
    const next = Math.max(0, Math.min(rows.length - 1, index + direction));
    if (next === index) {
      return index;
    }

    index = next;
    if (rows[index]?.kind === 'skill') {
      return index;
    }
  }
}

function providerSkillPriority(
  skill: DiscoveredSkill,
  provider: ProviderName,
  defaultSourcePaths: Set<string>,
  selectedProjectRoots: string[]
): number {
  const sourcePath = normalizeSkillPath(providerSkillSourceDir(skill));

  if (defaultSourcePaths.has(sourcePath)) {
    return 0;
  }

  if (pathWithinAny(skill.filePath, selectedProjectRoots)) {
    return 1;
  }

  if (skill.origin === 'project') {
    return 2;
  }

  if (pathWithinAny(skill.filePath, providerGlobalSkillRoots(provider))) {
    return 3;
  }

  if (skill.origin === 'global') {
    return 4;
  }

  return 5;
}

function buildProviderSkillRows(
  rootDir: string,
  provider: ProviderName,
  skills: DiscoveredSkill[],
  defaultSourcePaths: Set<string>,
  sessionSourcePaths: Set<string>
): ProviderSkillRow[] {
  if (!providerSupportsNativeExecutionSkills(provider)) {
    return [];
  }

  const rows: ProviderSkillRow[] = [];
  const selectedProjectRoots = providerProjectSkillRoots(rootDir, provider);
  const dedupedSkills = Array.from(
    skills.reduce((selected, skill) => {
      const key = skill.name.trim().toLowerCase();
      if (!key) {
        return selected;
      }

      const current = selected.get(key);
      if (!current) {
        selected.set(key, skill);
        return selected;
      }

      const currentPriority = providerSkillPriority(current, provider, defaultSourcePaths, selectedProjectRoots);
      const nextPriority = providerSkillPriority(skill, provider, defaultSourcePaths, selectedProjectRoots);
      if (nextPriority < currentPriority) {
        selected.set(key, skill);
      }

      return selected;
    }, new Map<string, DiscoveredSkill>()).values()
  );
  const addSection = (label: string, items: DiscoveredSkill[], detail: string) => {
    if (items.length === 0) {
      return;
    }

    rows.push({
      kind: 'section',
      id: `section:${label}`,
      label,
      detail,
      skill: null,
      checked: false,
      selectedByDefault: false
    });

    for (const skill of [...items].sort((left, right) => left.name.localeCompare(right.name))) {
      const sourcePath = normalizeSkillPath(providerSkillSourceDir(skill));
      const selectedByDefault = defaultSourcePaths.has(sourcePath);
      const selectedForRun = selectedByDefault || sessionSourcePaths.has(sourcePath);

      rows.push({
        kind: 'skill',
        id: `${provider}:${skill.id}`,
        label: skill.name,
        detail: selectedByDefault ? 'default' : selectedForRun ? 'this run' : truncateEnd(skill.label, 26),
        skill,
        checked: selectedForRun,
        selectedByDefault
      });
    }
  };

  const projectProviderSkills = dedupedSkills.filter(skill =>
    skill.origin === 'project' && pathWithinAny(skill.filePath, selectedProjectRoots)
  );
  const projectOtherSkills = dedupedSkills.filter(
    skill => skill.origin === 'project' && !pathWithinAny(skill.filePath, selectedProjectRoots)
  );

  addSection(`Project · ${provider}`, projectProviderSkills, 'Skills already inside the selected provider project directories.');
  addSection('Project · other providers', projectOtherSkills, 'Project skills found outside the selected provider directories.');

  for (const option of providerOptions) {
    const globalSkills = dedupedSkills.filter(
      skill => skill.origin === 'global' && pathWithinAny(skill.filePath, providerGlobalSkillRoots(option.value))
    );
    addSection(`Global · ${option.value}`, globalSkills, 'Global skills discovered in your home directory.');
  }

  if (rows.length === 0) {
    rows.push({
      kind: 'section',
      id: 'section:none',
      label: 'No provider skills found',
      detail: 'Add skills in the project or install them globally before selecting them here.',
      skill: null,
      checked: false,
      selectedByDefault: false
    });
  }

  return rows;
}

function textareaLines(value: string): string[] {
  return value.split(/\r?\n/);
}

function textareaWindow(value: string, visibleRows: number): { start: number; values: string[] } {
  const lines = textareaLines(value);
  const start = Math.max(0, lines.length - visibleRows);
  return {
    start,
    values: lines.slice(start, start + visibleRows)
  };
}

function buildPrdViewerLines(title: string, content: string): string[] {
  return [`File: ${title}`, '', ...content.split(/\r?\n/)];
}

function buildBacklogViewerLines(row: BacklogRow, backlog: BacklogSnapshot | null): string[] {
  if (row.kind !== 'item' || !row.itemId) {
    return [`PRD: ${path.basename(row.prdPath)}`, row.description];
  }

  const item = backlog?.items.find(entry => entry.id === row.itemId);
  if (!item) {
    return ['Backlog item not found.'];
  }

  return [
    `PRD: ${path.basename(row.prdPath)}`,
    `Item: ${item.title}`,
    `Status: ${statusLabel(item.status)}`,
    '',
    'Description:',
    ...(item.description ? item.description.split(/\r?\n/) : ['No description.']),
    '',
    'Steps:',
    ...(item.steps.length > 0
      ? item.steps.map(step => `- ${step.id} · ${statusLabel(step.status)} · ${step.title}`)
      : ['- No steps.']),
    '',
    `Notes: ${item.notes || 'None'}`
  ];
}

function WizardApp({
  rootDir,
  ralphDir,
  prdOptions,
  initial,
  onComplete,
  onCancel
}: WizardProps & { onComplete: (config: RalphConfig) => void; onCancel: () => void }) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>('home');
  const [homeIndex, setHomeIndex] = useState(0);
  const [pendingRunIndex, setPendingRunIndex] = useState(0);
  const [providerIndex, setProviderIndex] = useState(Math.max(0, providerOptions.findIndex(option => option.value === initial.tool)));
  const [scheduleIndex, setScheduleIndex] = useState(
    Math.max(0, scheduleOptions.findIndex(option => option.value === initial.schedule))
  );
  const [selectedExistingPrds, setSelectedExistingPrds] = useState<Set<string>>(
    () => new Set(initial.plans.map(plan => plan.sourcePrd))
  );
  const [createdDrafts, setCreatedDrafts] = useState<CreatedDraft[]>([]);
  const [draftForm, setDraftForm] = useState<DraftFormState>(() => ({
    title: initial.createPrdPrompt?.trim() ?? '',
    description: initial.createPrdPrompt?.trim() ?? '',
    field: 'title',
    fullscreen: false
  }));
  const [briefCreatedIndex, setBriefCreatedIndex] = useState(0);
  const [skillPicker, setSkillPicker] = useState<SkillPickerState | null>(null);
  const [skillModeIndex, setSkillModeIndex] = useState(0);
  const [directorySkillCursor, setDirectorySkillCursor] = useState(0);
  const [directorySkillWindowStart, setDirectorySkillWindowStart] = useState(0);
  const [singlePrdVariantCount, setSinglePrdVariantCount] = useState(() => {
    const uniqueSources = new Set(initial.plans.map(plan => plan.sourcePrd));
    return uniqueSources.size === 1 && initial.plans.length > 1 ? initial.plans.length : 2;
  });
  const [iterationValues, setIterationValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const plan of initial.plans) {
      if (plan.variantIndex && initial.plans.length > 1) {
        seed[variantIterationKey(plan.sourcePrd, plan.variantIndex)] = String(plan.iterations);
      } else {
        seed[plan.sourcePrd] = String(plan.iterations);
      }
    }
    return seed;
  });
  const [dependencyValues, setDependencyValues] = useState<Record<string, string | null>>(() => {
    const sourceByPlanId = new Map(initial.plans.map(plan => [plan.id, plan.sourcePrd] as const));
    const seed: Record<string, string | null> = {};
    for (const plan of initial.plans) {
      seed[plan.sourcePrd] = plan.dependsOn ? sourceByPlanId.get(plan.dependsOn) ?? null : null;
    }
    return seed;
  });
  const [prdCursor, setPrdCursor] = useState(0);
  const [prdWindowStart, setPrdWindowStart] = useState(0);
  const [bootstrapCursor, setBootstrapCursor] = useState(0);
  const [bootstrapWindowStart, setBootstrapWindowStart] = useState(0);
  const [backlogCursor, setBacklogCursor] = useState(0);
  const [backlogWindowStart, setBacklogWindowStart] = useState(0);
  const [dependencyCursor, setDependencyCursor] = useState(0);
  const [dependencyWindowStart, setDependencyWindowStart] = useState(0);
  const [backlogPolicyCursor, setBacklogPolicyCursor] = useState(0);
  const [backlogPolicyWindowStart, setBacklogPolicyWindowStart] = useState(0);
  const [iterationCursor, setIterationCursor] = useState(0);
  const [iterationWindowStart, setIterationWindowStart] = useState(0);
  const [tokenBudgetEnabled, setTokenBudgetEnabled] = useState(Boolean(initial.tokenBudget));
  const [tokenBudgetInput, setTokenBudgetInput] = useState(initial.tokenBudget ? String(initial.tokenBudget.limitTokens) : '');
  const [skillMenuIndex, setSkillMenuIndex] = useState(0);
  const [skillCatalogCursor, setSkillCatalogCursor] = useState(0);
  const [skillCatalogWindowStart, setSkillCatalogWindowStart] = useState(0);
  const [skillSource, setSkillSource] = useState<SkillCatalogSource>('openai');
  const [skillInput, setSkillInput] = useState('');
  const [skillTargetIndex, setSkillTargetIndex] = useState(0);
  const [scopeIndex, setScopeIndex] = useState(0);
  const [environmentIndex, setEnvironmentIndex] = useState(
    initial.executionEnvironment === 'devcontainer' && initial.devcontainerConfigPath ? 1 : 0
  );
  const [installError, setInstallError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [arcadeOpen, setArcadeOpen] = useState(false);
  const [backlogBatchProgress, setBacklogBatchProgress] = useState<BacklogBatchProgress | null>(null);
  const [skillInstallProgress, setSkillInstallProgress] = useState<SkillInstallProgress | null>(null);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillView>({
    builtin: [],
    project: [],
    global: []
  });
  const [projectBootstrap, setProjectBootstrap] = useState<ProjectBootstrapInspection>({
    items: [],
    devcontainerConfigPath: initial.devcontainerConfigPath
  });
  const [skillCatalogCache, setSkillCatalogCache] = useState<Partial<Record<'openai' | 'claude', CatalogSkillEntry[]>>>({});
  const [skillCatalogEntries, setSkillCatalogEntries] = useState<CatalogSkillEntry[]>([]);
  const [selectedCatalogIds, setSelectedCatalogIds] = useState<Set<string>>(new Set());
  const [pendingSkillInstalls, setPendingSkillInstalls] = useState<SkillInstallSpec[]>([]);
  const [directorySkills, setDirectorySkills] = useState<DiscoveredSkill[]>([]);
  const [projectConfig, setProjectConfig] = useState(initial.projectConfig);
  const [notificationMenuCursor, setNotificationMenuCursor] = useState(0);
  const [notificationEventCursor, setNotificationEventCursor] = useState(0);
  const [notificationChannelCursor, setNotificationChannelCursor] = useState(0);
  const [notificationChannelWindowStart, setNotificationChannelWindowStart] = useState(0);
  const [notificationEditChannel, setNotificationEditChannel] = useState<NotificationChannel | null>(null);
  const [notificationUrlInput, setNotificationUrlInput] = useState('');
  const [cleanupPreview, setCleanupPreview] = useState<WorktreeCleanupResult | null>(null);
  const [cleanupInput, setCleanupInput] = useState('');
  const [selectedPrdSkill, setSelectedPrdSkill] = useState<DiscoveredSkill | null>(null);
  const [selectedBacklogSkill, setSelectedBacklogSkill] = useState<DiscoveredSkill | null>(null);
  const [backlogPolicyRows, setBacklogPolicyRows] = useState<BacklogPolicyRow[]>([]);
  const [backlogByPrd, setBacklogByPrd] = useState<Record<string, BacklogSnapshot | null>>({});
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [prdEditor, setPrdEditor] = useState<PrdEditorState | null>(null);
  const [backlogEditor, setBacklogEditor] = useState<BacklogEditorState | null>(null);
  const [providerSkillCursor, setProviderSkillCursor] = useState(0);
  const [providerSkillWindowStart, setProviderSkillWindowStart] = useState(0);
  const [providerSkillActionIndex, setProviderSkillActionIndex] = useState(0);
  const [providerSkillDecision, setProviderSkillDecision] = useState<ProviderSkillDecisionState | null>(null);
  const [sessionExecutionSkills, setSessionExecutionSkills] = useState<Record<string, RalphExecutionSkill>>({});
  const [pendingRun, setPendingRun] = useState<PendingRunState | null>(null);
  const [launchDoctorReport, setLaunchDoctorReport] = useState<DoctorReport | null>(null);

  const { columns, rows } = useTerminalViewport();
  const compact = rows < 34;
  const sidebarWidth = Math.max(24, Math.min(34, Math.floor(columns * 0.34)));
  const sidebarLabelWidth = 11;
  const sidebarValueWidth = Math.max(8, sidebarWidth - 16);
  const prdRows = Math.max(4, rows - (compact ? 18 : 22));
  const backlogRows = Math.max(4, rows - (compact ? 18 : 22));
  const dependencyRowsVisible = Math.max(4, rows - (compact ? 18 : 22));
  const providerSkillRowsVisible = Math.max(4, rows - (compact ? 18 : 22));
  const notificationRowsVisible = Math.max(6, rows - (compact ? 20 : 24));
  const iterationRows = Math.max(4, rows - (compact ? 18 : 22));
  const builtinPrdSkill = useMemo<DiscoveredSkill>(
    () => ({
      id: 'ralphi:builtin:prd',
      name: 'prd',
      description: 'Ralphi built-in PRD generator.',
      filePath: builtinSkillFile('prd'),
      rootDir: path.dirname(builtinSkillFile('prd')),
      provider: 'ralphi',
      origin: 'builtin',
      label: 'Ralphi built-in',
      external: false
    }),
    []
  );
  const builtinBacklogSkill = useMemo<DiscoveredSkill>(
    () => ({
      id: 'ralphi:builtin:ralphi-backlog',
      name: 'ralphi-backlog',
      description: 'Ralphi built-in backlog generator.',
      filePath: builtinSkillFile('ralphi-backlog'),
      rootDir: path.dirname(builtinSkillFile('ralphi-backlog')),
      provider: 'ralphi',
      origin: 'builtin',
      label: 'Ralphi built-in',
      external: false
    }),
    []
  );
  const bootstrapRows = Math.max(4, rows - (compact ? 18 : 22));
  const directoryRows = Math.max(4, rows - (compact ? 18 : 22));
  const skillCatalogRows = Math.max(4, rows - (compact ? 18 : 22));
  const backlogPolicyRowsVisible = Math.max(4, rows - (compact ? 18 : 22));
  const viewerRows = Math.max(8, rows - (compact ? 18 : 20));
  const hasRecommendedBootstrapItems = projectBootstrap.items.some(item => item.recommended);
  const hasOptionalBootstrapOnly = projectBootstrap.items.length > 0 && !hasRecommendedBootstrapItems;
  const homeOptionByValue = new Map(baseHomeOptions.map(option => [option.value, option] as const));
  const homeOptions = useMemo<Array<{ value: HomeAction; label: string; description: string }>>(() => {
    const runExisting = homeOptionByValue.get('run-existing')!;
    const createPrd = homeOptionByValue.get('create-prd')!;
    const notifications = homeOptionByValue.get('notifications')!;
    const manageSkills = homeOptionByValue.get('manage-skills')!;
    const cleanup = homeOptionByValue.get('cleanup')!;
    const about = homeOptionByValue.get('about')!;

    const trailing = [notifications, manageSkills, cleanup, about];

    if (projectBootstrap.items.length === 0) {
      return [runExisting, createPrd, ...trailing];
    }

    return [
      runExisting,
      createPrd,
      {
        value: 'bootstrap',
        label: hasRecommendedBootstrapItems ? 'Project bootstrap' : 'Optional bootstrap',
        description: hasRecommendedBootstrapItems
          ? 'Review recommended project scaffolds before launch.'
          : 'Open optional scaffolds such as a starter devcontainer.'
      },
      ...trailing
    ];
  }, [hasRecommendedBootstrapItems, projectBootstrap.items.length]);
  const activeHome = homeOptions[homeIndex] ?? homeOptions[0];
  const activeProvider = providerOptions[providerIndex] ?? providerOptions[0];
  const activeProviderHasNativeSkills = providerSupportsNativeExecutionSkills(activeProvider.value);
  const activeProviderStructureLines = providerStructureLines(activeProvider.value);
  const entryWorkScreen: Screen = activeHome.value === 'create-prd' ? 'brief' : 'prds';
  const activeSchedule = scheduleOptions[scheduleIndex] ?? scheduleOptions[0];
  const activeSkillMenu = skillMenuOptions[skillMenuIndex] ?? skillMenuOptions[0];
  const selectedPrdPaths = activeHome.value === 'create-prd' ? createdDrafts.map(draft => draft.path) : Array.from(selectedExistingPrds);
  const plans = useMemo(
    () => buildPlans(ralphDir, selectedPrdPaths, iterationValues, activeSchedule.value, singlePrdVariantCount, dependencyValues),
    [activeSchedule.value, dependencyValues, iterationValues, ralphDir, selectedPrdPaths, singlePrdVariantCount]
  );
  const launchPlanWorkspaceStrategy = activeSchedule.value === 'parallel' || selectedPrdPaths.length > 1 ? 'worktree' : initial.workspaceStrategy;
  const dependencyRowsAll = useMemo(() => buildDependencyRows(selectedPrdPaths, dependencyValues), [dependencyValues, selectedPrdPaths]);
  const dependencyOrderLabel = useMemo(() => {
    if (plans.length <= 1) {
      return null;
    }

    try {
      return sortPlansByDependencies(plans).map(plan => path.basename(plan.sourcePrd)).join(' → ');
    } catch {
      return null;
    }
  }, [plans]);
  const dependencyCount = plans.filter(plan => Boolean(plan.dependsOn)).length;
  const backlogRowsAll = useMemo(() => buildBacklogRows(selectedPrdPaths, backlogByPrd), [backlogByPrd, selectedPrdPaths]);
  const iterationEntries = useMemo(
    () => buildIterationEntries(selectedPrdPaths, activeSchedule.value, singlePrdVariantCount, iterationValues),
    [activeSchedule.value, iterationValues, selectedPrdPaths, singlePrdVariantCount]
  );
  const selectedCatalogEntries = useMemo(
    () => skillCatalogEntries.filter(entry => selectedCatalogIds.has(entry.id)),
    [selectedCatalogIds, skillCatalogEntries]
  );
  const activeDirectorySkill = directorySkills[directorySkillCursor] ?? directorySkills[0] ?? null;
  const activeBacklogPolicyRow = backlogPolicyRows[backlogPolicyCursor] ?? null;
  const activeBootstrapItem = projectBootstrap.items[bootstrapCursor] ?? null;
  const activeSkillCatalogEntry = skillCatalogEntries[skillCatalogCursor] ?? null;
  const availableEnvironmentOptions =
    projectBootstrap.devcontainerConfigPath || initial.devcontainerConfigPath ? environmentOptions : [environmentOptions[0]];
  const activeEnvironment = availableEnvironmentOptions[environmentIndex] ?? availableEnvironmentOptions[0];
  const activeSkillTarget = skillTargetOptions[skillTargetIndex] ?? skillTargetOptions[0];
  const pendingSkillTarget = pendingSkillInstalls[0]?.target ?? activeSkillTarget.value;
  const activeNotificationMenu = notificationMenuOptions[notificationMenuCursor] ?? notificationMenuOptions[0];
  const notificationEventRows = useMemo(() => buildNotificationEventRows(projectConfig.notifications), [projectConfig.notifications]);
  const activeNotificationEventRow = notificationEventRows[notificationEventCursor] ?? notificationEventRows[0] ?? null;
  const notificationChannelRows = useMemo(() => buildNotificationChannelRows(projectConfig.notifications), [projectConfig.notifications]);
  const activeNotificationChannelRow = notificationChannelRows[notificationChannelCursor] ?? notificationChannelRows[0] ?? null;
  const editorFullscreen = draftForm.fullscreen || Boolean(prdEditor?.fullscreen) || Boolean(backlogEditor?.fullscreen);
  const showSidebar = (!compact || screen === 'home' || screen === 'bootstrap' || screen === 'about' || screen === 'notifications' || screen === 'notification-events' || screen === 'notification-channels' || screen === 'cleanup-confirm') && !editorFullscreen && !arcadeOpen;
  const activeSessionExecutionSkills = useMemo(
    () => Object.values(sessionExecutionSkills).filter(skill => skill.provider === activeProvider.value),
    [activeProvider.value, sessionExecutionSkills]
  );
  const defaultExecutionSkills = useMemo(
    () => buildExecutionSkills(rootDir, activeProvider.value, projectConfig).filter(skill => skill.persisted),
    [activeProvider.value, projectConfig, rootDir]
  );
  const activeExecutionSkills = useMemo(
    () => buildExecutionSkills(rootDir, activeProvider.value, projectConfig, activeSessionExecutionSkills),
    [activeProvider.value, activeSessionExecutionSkills, projectConfig, rootDir]
  );
  const defaultExecutionSourcePaths = useMemo(
    () => new Set(defaultExecutionSkills.map(skill => normalizeSkillPath(skill.sourcePath))),
    [defaultExecutionSkills]
  );
  const sessionExecutionSourcePaths = useMemo(
    () => new Set(activeSessionExecutionSkills.map(skill => normalizeSkillPath(skill.sourcePath))),
    [activeSessionExecutionSkills]
  );
  const providerSkillRows = useMemo(
    () => buildProviderSkillRows(rootDir, activeProvider.value, directorySkills, defaultExecutionSourcePaths, sessionExecutionSourcePaths),
    [activeProvider.value, defaultExecutionSourcePaths, directorySkills, rootDir, sessionExecutionSourcePaths]
  );
  const activeProviderSkillRow = providerSkillRows[providerSkillCursor] ?? providerSkillRows[0] ?? null;
  const activeProviderSkill = activeProviderSkillRow?.kind === 'skill' ? activeProviderSkillRow.skill : null;
  const parsedTokenBudget = useMemo(() => {
    if (!tokenBudgetEnabled) {
      return null;
    }

    const value = Number(tokenBudgetInput);
    return Number.isInteger(value) && value > 0 ? value : null;
  }, [tokenBudgetEnabled, tokenBudgetInput]);
  const reviewProjectConfig = useMemo(
    () => ({
      ...projectConfig,
      notifications: normalizeNotificationSettings(projectConfig.notifications),
      defaults: {
        ...projectConfig.defaults,
        tool: activeProvider.value,
        schedule: activeSchedule.value,
        workspaceStrategy: launchPlanWorkspaceStrategy,
        iterations: Math.max(...plans.map(plan => plan.iterations), 1),
        environment: activeEnvironment.value
      }
    }),
    [activeEnvironment.value, activeProvider.value, activeSchedule.value, launchPlanWorkspaceStrategy, plans, projectConfig]
  );
  const reviewConfig = useMemo<RalphConfig>(
    () => ({
      ...initial,
      tool: activeProvider.value,
      executionSkills: buildExecutionSkills(rootDir, activeProvider.value, reviewProjectConfig, activeSessionExecutionSkills),
      plans,
      maxIterations: Math.max(...plans.map(plan => plan.iterations), 1),
      tokenBudget: parsedTokenBudget
        ? {
            limitTokens: parsedTokenBudget,
            baselineTokens: 0
          }
        : null,
      schedule: activeSchedule.value,
      workspaceStrategy: launchPlanWorkspaceStrategy,
      executionEnvironment: activeEnvironment.value,
      devcontainerConfigPath: projectBootstrap.devcontainerConfigPath ?? initial.devcontainerConfigPath,
      launchMode: 'run-existing',
      createPrdPrompt: undefined,
      projectConfig: reviewProjectConfig
    }),
    [
      activeEnvironment.value,
      activeProvider.value,
      activeSchedule.value,
      activeSessionExecutionSkills,
      initial,
      launchPlanWorkspaceStrategy,
      plans,
      parsedTokenBudget,
      projectBootstrap.devcontainerConfigPath,
      reviewProjectConfig,
      rootDir
    ]
  );

  useEffect(() => {
    let cancelled = false;

    void Promise.all([
      inspectProjectBootstrap(rootDir),
      listBuiltinSkills(),
      listInstalledSkills(rootDir),
      discoverSkills(rootDir, {
        includeBuiltinRalphi: false,
        includeRalphiManaged: false,
        includeProviderDirs: true,
        externalOnly: true
      }),
      loadPendingRunSession(ralphDir)
    ]).then(async ([inspection, builtin, installed, discovered, pendingSession]) => {
      if (cancelled) {
        return;
      }

      setProjectBootstrap(inspection);
      setInstalledSkills({
        builtin,
        project: installed.project,
        global: installed.global
      });
      setDirectorySkills(discovered);

      if (pendingSession) {
        const [checkpoints, driftReport] = await Promise.all([
          listCheckpointSnapshots(pendingSession.config),
          evaluateResumeDrift(pendingSession)
        ]);
        if (!cancelled) {
          setPendingRun({
            session: pendingSession,
            checkpoints,
            driftReport
          });
        }
        return;
      }

      if (inspection.items.some(item => item.recommended)) {
        setScreen(current => (current === 'home' ? 'bootstrap' : current));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [ralphDir, rootDir]);

  useEffect(() => {
    if (!pendingRun) {
      return;
    }

    setScreen('resume-run');
  }, [pendingRun]);

  useEffect(() => {
    let cancelled = false;

    if (screen !== 'review' || plans.length === 0) {
      setLaunchDoctorReport(null);
      return;
    }

    void runDoctor(reviewConfig).then(report => {
      if (!cancelled) {
        setLaunchDoctorReport(report);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [plans.length, reviewConfig, screen]);

  useEffect(() => {
    setPrdWindowStart(current => nextWindowStart(current, prdCursor, prdOptions.length, prdRows));
  }, [prdCursor, prdOptions.length, prdRows]);

  useEffect(() => {
    setHomeIndex(current => Math.max(0, Math.min(current, Math.max(0, homeOptions.length - 1))));
  }, [homeOptions.length]);

  useEffect(() => {
    setBootstrapWindowStart(current => nextWindowStart(current, bootstrapCursor, projectBootstrap.items.length, bootstrapRows));
  }, [bootstrapCursor, bootstrapRows, projectBootstrap.items.length]);

  useEffect(() => {
    setBacklogWindowStart(current => nextWindowStart(current, backlogCursor, backlogRowsAll.length, backlogRows));
  }, [backlogCursor, backlogRows, backlogRowsAll.length]);

  useEffect(() => {
    setDependencyWindowStart(current => nextWindowStart(current, dependencyCursor, dependencyRowsAll.length, dependencyRowsVisible));
  }, [dependencyCursor, dependencyRowsAll.length, dependencyRowsVisible]);

  useEffect(() => {
    setDirectorySkillWindowStart(current => nextWindowStart(current, directorySkillCursor, directorySkills.length, directoryRows));
  }, [directoryRows, directorySkillCursor, directorySkills.length]);

  useEffect(() => {
    setProviderSkillWindowStart(current => nextWindowStart(current, providerSkillCursor, providerSkillRows.length, providerSkillRowsVisible));
  }, [providerSkillCursor, providerSkillRows.length, providerSkillRowsVisible]);

  useEffect(() => {
    setNotificationChannelWindowStart(current =>
      nextWindowStart(current, notificationChannelCursor, notificationChannelRows.length, notificationRowsVisible)
    );
  }, [notificationChannelCursor, notificationChannelRows.length, notificationRowsVisible]);

  useEffect(() => {
    setSkillCatalogWindowStart(current => nextWindowStart(current, skillCatalogCursor, skillCatalogEntries.length, skillCatalogRows));
  }, [skillCatalogCursor, skillCatalogEntries.length, skillCatalogRows]);

  useEffect(() => {
    setBacklogPolicyWindowStart(current =>
      nextWindowStart(current, backlogPolicyCursor, backlogPolicyRows.length, backlogPolicyRowsVisible)
    );
  }, [backlogPolicyCursor, backlogPolicyRows.length, backlogPolicyRowsVisible]);

  useEffect(() => {
    setIterationWindowStart(current => nextWindowStart(current, iterationCursor, iterationEntries.length, iterationRows));
  }, [iterationCursor, iterationEntries.length, iterationRows]);

  useEffect(() => {
    const selected = new Set(selectedPrdPaths);
    setDependencyValues(current => {
      const next: Record<string, string | null> = {};
      for (const prdPath of selectedPrdPaths) {
        const dependencyPath = current[prdPath] ?? null;
        next[prdPath] = dependencyPath && selected.has(dependencyPath) && dependencyPath !== prdPath ? dependencyPath : null;
      }

      const currentKeys = Object.keys(current).sort();
      const nextKeys = Object.keys(next).sort();
      if (currentKeys.length === nextKeys.length && currentKeys.every((key, index) => key === nextKeys[index] && current[key] === next[key])) {
        return current;
      }

      return next;
    });
  }, [selectedPrdPaths]);

  useEffect(() => {
    setBacklogCursor(current => Math.max(0, Math.min(current, Math.max(0, backlogRowsAll.length - 1))));
  }, [backlogRowsAll.length]);

  useEffect(() => {
    setDependencyCursor(current => Math.max(0, Math.min(current, Math.max(0, dependencyRowsAll.length - 1))));
  }, [dependencyRowsAll.length]);

  useEffect(() => {
    setBootstrapCursor(current => Math.max(0, Math.min(current, Math.max(0, projectBootstrap.items.length - 1))));
  }, [projectBootstrap.items.length]);

  useEffect(() => {
    setDirectorySkillCursor(current => Math.max(0, Math.min(current, Math.max(0, directorySkills.length - 1))));
  }, [directorySkills.length]);

  useEffect(() => {
    const maxIndex = Math.max(0, providerSkillRows.length - 1);
    const safeIndex = Math.max(0, Math.min(providerSkillCursor, maxIndex));
    if (providerSkillRows[safeIndex]?.kind === 'skill') {
      if (safeIndex !== providerSkillCursor) {
        setProviderSkillCursor(safeIndex);
      }
      return;
    }

    const firstSkillIndex = providerSkillRows.findIndex(row => row.kind === 'skill');
    setProviderSkillCursor(firstSkillIndex === -1 ? 0 : firstSkillIndex);
  }, [providerSkillCursor, providerSkillRows]);

  useEffect(() => {
    setNotificationMenuCursor(current => Math.max(0, Math.min(current, Math.max(0, notificationMenuOptions.length - 1))));
  }, []);

  useEffect(() => {
    setNotificationEventCursor(current => Math.max(0, Math.min(current, Math.max(0, notificationEventRows.length - 1))));
  }, [notificationEventRows.length]);

  useEffect(() => {
    setNotificationChannelCursor(current => Math.max(0, Math.min(current, Math.max(0, notificationChannelRows.length - 1))));
  }, [notificationChannelRows.length]);

  useEffect(() => {
    setSkillCatalogCursor(current => Math.max(0, Math.min(current, Math.max(0, skillCatalogEntries.length - 1))));
  }, [skillCatalogEntries.length]);

  useEffect(() => {
    setBacklogPolicyCursor(current => Math.max(0, Math.min(current, Math.max(0, backlogPolicyRows.length - 1))));
  }, [backlogPolicyRows.length]);

  useEffect(() => {
    setIterationCursor(current => Math.max(0, Math.min(current, Math.max(0, iterationEntries.length - 1))));
  }, [iterationEntries.length]);

  useEffect(() => {
    if (activeSchedule.value !== 'parallel' || selectedPrdPaths.length !== 1) {
      return;
    }

    setSinglePrdVariantCount(current => Math.max(2, current));
  }, [activeSchedule.value, selectedPrdPaths.length]);

  useEffect(() => {
    setEnvironmentIndex(current => Math.max(0, Math.min(current, Math.max(0, availableEnvironmentOptions.length - 1))));
  }, [availableEnvironmentOptions.length]);

  const refreshInstalledSkills = async (): Promise<void> => {
    const [builtin, installed, discovered] = await Promise.all([
      listBuiltinSkills(),
      listInstalledSkills(rootDir),
      discoverSkills(rootDir, {
        includeBuiltinRalphi: false,
        includeRalphiManaged: false,
        includeProviderDirs: true,
        externalOnly: true
      })
    ]);
    setInstalledSkills({
      builtin,
      project: installed.project,
      global: installed.global
    });
    setDirectorySkills(discovered);
  };

  const persistProjectConfigState = async (nextConfig: RalphConfig['projectConfig'], successMessage?: string): Promise<void> => {
    try {
      await saveProjectConfig(rootDir, nextConfig);
      setProjectConfig(nextConfig);
      if (successMessage) {
        setNotice(successMessage);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to save .ralphi.json.');
    }
  };

  const openNotificationEditor = (channel: NotificationChannel): void => {
    const notifications = normalizeNotificationSettings(projectConfig.notifications);
    setNotificationEditChannel(channel);
    setNotificationUrlInput(notifications.channels[channel]?.url ?? '');
    setNotice(null);
    setScreen('notification-edit');
  };

  const toggleNotificationEvent = async (event: NotificationEventKey): Promise<void> => {
    const notifications = normalizeNotificationSettings(projectConfig.notifications);
    const nextConfig = {
      ...projectConfig,
      notifications: {
        ...notifications,
        events: {
          ...notifications.events,
          [event]: !notifications.events[event]
        }
      }
    };

    const label = notificationEventOptions.find(option => option.value === event)?.label ?? event;
    await persistProjectConfigState(nextConfig, `${label} ${nextConfig.notifications.events[event] ? 'enabled' : 'disabled'}.`);
  };

  const toggleNotificationChannel = async (channel: NotificationChannel): Promise<void> => {
    const notifications = normalizeNotificationSettings(projectConfig.notifications);
    const current = notifications.channels[channel];
    if (!current?.url) {
      openNotificationEditor(channel);
      return;
    }

    const nextConfig = {
      ...projectConfig,
      notifications: {
        ...notifications,
        channels: {
          ...notifications.channels,
          [channel]: {
            enabled: !current.enabled,
            url: current.url
          }
        }
      }
    };

    await persistProjectConfigState(
      nextConfig,
      `${notificationChannelLabel(channel)} ${nextConfig.notifications.channels[channel]?.enabled ? 'enabled' : 'disabled'}.`
    );
  };

  const saveNotificationChannelInput = async (): Promise<void> => {
    if (!notificationEditChannel) {
      setScreen('notification-channels');
      return;
    }

    const notifications = normalizeNotificationSettings(projectConfig.notifications);
    const url = notificationUrlInput.trim();
    const nextConfig = {
      ...projectConfig,
      notifications: {
        ...notifications,
        channels: {
          ...notifications.channels,
          [notificationEditChannel]: {
            enabled: Boolean(url),
            url
          }
        }
      }
    };

    await persistProjectConfigState(
      nextConfig,
      url
        ? `${notificationChannelLabel(notificationEditChannel)} webhook saved.`
        : `${notificationChannelLabel(notificationEditChannel)} webhook cleared.`
    );
    setNotificationEditChannel(null);
    setScreen('notification-channels');
  };

  const openCleanupScreen = async (): Promise<void> => {
    setBusyMessage('Inspecting Ralphi worktrees and branches...');
    setNotice(null);

    try {
      const preview = await cleanupManagedWorktrees(rootDir, ralphDir, true);
      setCleanupPreview(preview);
      setCleanupInput('');
      setScreen('cleanup-confirm');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to inspect Ralphi worktrees and branches.');
    } finally {
      setBusyMessage(null);
    }
  };

  const runCleanupNow = async (): Promise<void> => {
    if (cleanupInput !== 'CLEANUP') {
      setNotice('Type CLEANUP exactly to confirm the destructive cleanup.');
      return;
    }

    setBusyMessage('Removing Ralphi worktrees and branches...');
    setNotice(null);

    try {
      const result = await cleanupManagedWorktrees(rootDir, ralphDir, false);
      setCleanupPreview(result);
      setCleanupInput('');
      setPendingRun(null);
      setPendingRunIndex(0);
      setScreen(returnHomeScreen);
      setNotice(
        `Removed ${result.actionable.length} worktree${result.actionable.length === 1 ? '' : 's'} and ${result.actionableBranches.length} branch${result.actionableBranches.length === 1 ? '' : 'es'}.`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to remove the managed Ralphi worktrees and branches.');
    } finally {
      setBusyMessage(null);
    }
  };

  const returnHomeScreen = hasRecommendedBootstrapItems ? 'bootstrap' : 'home';

  const applyPendingRunChoice = async (choice: PendingRunAction): Promise<void> => {
    if (!pendingRun) {
      setScreen(returnHomeScreen);
      return;
    }

    if (choice === 'continue') {
      if (pendingRun.driftReport.classification === 'must_restart') {
        setNotice('Resume is unsafe because the saved session drifted from the current workspace. Restart the run instead.');
        return;
      }

      onComplete(pendingRun.session.config);
      exit();
      return;
    }

    setBusyMessage(choice === 'restart' ? 'Resetting saved execution...' : 'Discarding saved execution...');
    setNotice(null);

    try {
      await clearRunState(pendingRun.session.config);
      if (choice === 'restart') {
        onComplete(pendingRun.session.config);
        exit();
        return;
      }

      setPendingRun(null);
      setPendingRunIndex(0);
      setScreen(returnHomeScreen);
      setNotice('Saved execution state removed.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to update the saved execution.');
    } finally {
      setBusyMessage(null);
    }
  };

  const openProviderSkillPreview = async (skill: DiscoveredSkill): Promise<void> => {
    setBusyMessage(`Loading ${skill.name}...`);
    setNotice(null);

    try {
      const content = await loadSkillFile(skill.filePath);
      setViewer({
        kind: 'skill',
        title: skill.name,
        subtitle: skill.label.toUpperCase(),
        lines: buildPrdViewerLines(path.basename(skill.filePath), content),
        scroll: 0,
        returnScreen: 'provider-skills'
      });
      setScreen('skill-view');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to load the selected skill.');
    } finally {
      setBusyMessage(null);
    }
  };

  const toggleProviderSkillSelection = (skill: DiscoveredSkill): void => {
    if (!activeProviderHasNativeSkills) {
      setNotice(`${activeProvider.value} uses its own native project structure instead of SKILL.md execution skills.`);
      return;
    }

    const sourcePath = normalizeSkillPath(providerSkillSourceDir(skill));
    if (defaultExecutionSourcePaths.has(sourcePath)) {
      setNotice(`${skill.name} is already selected in .ralphi.json for ${activeProvider.value}.`);
      return;
    }

    const sessionId = providerSkillStateId(activeProvider.value, skill);
    if (sessionExecutionSkills[sessionId]) {
      setSessionExecutionSkills(current => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      setNotice(`Removed ${skill.name} from this execution.`);
      return;
    }

    setProviderSkillDecision({ skill });
    setProviderSkillActionIndex(0);
    setNotice(null);
    setScreen('provider-skill-action');
  };

  const applyProviderSkillDecision = async (
    mode: (typeof providerSkillDecisionOptions)[number]['value']
  ): Promise<void> => {
    const decision = providerSkillDecision;
    if (!decision) {
      setScreen('provider-skills');
      return;
    }

    if (mode === 'session') {
      const nextSkill = buildSessionExecutionSkill(activeProvider.value, decision.skill);
      setSessionExecutionSkills(current => ({
        ...current,
        [nextSkill.id]: nextSkill
      }));
      setProviderSkillDecision(null);
      setScreen('provider-skills');
      setNotice(`Using ${decision.skill.name} in this execution.`);
      return;
    }

    setBusyMessage(`Adding ${decision.skill.name} to project skills...`);
    setNotice(null);

    try {
      const target = providerSkillTarget(activeProvider.value);
      if (!target) {
        throw new Error(`${activeProvider.value} uses its own native project structure instead of SKILL.md execution skills.`);
      }

      const sourceDir = providerSkillSourceDir(decision.skill);
      const targetDir = resolveSkillTargetDir(rootDir, 'project', target, decision.skill.name);
      const willCopy = normalizeSkillPath(sourceDir) !== normalizeSkillPath(targetDir) && !(await pathExists(targetDir));

      await installLocalSkill({
        rootDir,
        name: decision.skill.name,
        sourceDir,
        scope: 'project',
        target
      });

      const nextConfig = await addProjectSkill(rootDir, buildLocalProjectSkillSpec(rootDir, activeProvider.value, decision.skill));
      setProjectConfig(nextConfig);
      setSessionExecutionSkills(current =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([, skill]) => !(skill.provider === activeProvider.value && skill.name === decision.skill.name)
          )
        )
      );
      await refreshInstalledSkills();
      setProviderSkillDecision(null);
      setScreen('provider-skills');
      setNotice(
        willCopy
          ? `Copied ${decision.skill.name} into the project and added it to .ralphi.json.`
          : `Added ${decision.skill.name} to .ralphi.json.`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to add the selected skill.');
    } finally {
      setBusyMessage(null);
    }
  };

  const loadSkillCatalog = async (source: SkillCatalogSource): Promise<void> => {
    if (source === 'github') {
      setSkillSource(source);
      setSkillInput('');
      setSkillTargetIndex(0);
      setPendingSkillInstalls([]);
      setInstallError(null);
      setNotice(null);
      setScreen('skill-input');
      return;
    }

    const cachedEntries = skillCatalogCache[source];
    if (cachedEntries && cachedEntries.length > 0) {
      setSkillSource(source);
      setSkillCatalogEntries(cachedEntries);
      setSelectedCatalogIds(new Set());
      setSkillCatalogCursor(0);
      setPendingSkillInstalls([]);
      setInstallError(null);
      setNotice(null);
      setScreen('skill-catalog');
      return;
    }

    setBusyMessage(source === 'openai' ? 'Loading OpenAI skill catalog...' : 'Loading Claude skill catalog...');
    setInstallError(null);
    setNotice(null);

    try {
      const entries = source === 'openai' ? await listOpenAiCatalog() : await listClaudeCatalog();
      setSkillCatalogCache(current => ({
        ...current,
        [source]: entries
      }));
      setSkillSource(source);
      setSkillCatalogEntries(entries);
      setSelectedCatalogIds(new Set());
      setSkillCatalogCursor(0);
      setPendingSkillInstalls([]);
      setScreen('skill-catalog');
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Unable to load the remote skill catalog.');
    } finally {
      setBusyMessage(null);
    }
  };

  const openSkillPreview = async (
    previewLoader: Promise<CatalogSkillPreview>,
    nextScreen: 'skill-catalog' | 'skill-input'
  ): Promise<void> => {
    setBusyMessage('Loading skill preview...');
    setInstallError(null);
    setNotice(null);

    try {
      const preview = await previewLoader;
      setViewer({
        kind: 'skill',
        title: preview.entry.name,
        subtitle: preview.entry.catalogLabel.toUpperCase(),
        lines: buildCatalogPreviewLines(preview),
        scroll: 0,
        returnScreen: nextScreen
      });
      setScreen('skill-view');
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Unable to preview the selected skill.');
    } finally {
      setBusyMessage(null);
    }
  };

  const openBootstrapPreview = (item: ProjectBootstrapItem): void => {
    setViewer({
      kind: 'bootstrap',
      title: item.previewTitle,
      subtitle: 'BOOTSTRAP',
      lines: item.previewLines,
      scroll: 0,
      returnScreen: 'bootstrap'
    });
    setScreen('bootstrap-view');
  };

  const installSkillBatch = async (scope: 'project' | 'global', overrideTarget?: SkillInstallTarget): Promise<void> => {
    if (pendingSkillInstalls.length === 0) {
      setInstallError('Select at least one skill before continuing.');
      return;
    }

    const nextSpecs = pendingSkillInstalls.map(spec => ({
      ...spec,
      scope,
      target: overrideTarget ?? spec.target
    }));

    setSkillInstallProgress(null);
    setBusyMessage(`Installing ${nextSpecs.length} skill${nextSpecs.length === 1 ? '' : 's'}...`);
    setScreen('skill-progress');

    try {
      for (let index = 0; index < nextSpecs.length; index += 1) {
        const spec = nextSpecs[index];
        setSkillInstallProgress(current => ({
          total: nextSpecs.length,
          current: index,
          currentLabel: spec.name,
          history: current?.history ?? []
        }));
        setBusyMessage(`Installing ${index + 1}/${nextSpecs.length}: ${spec.name}...`);

        const installation = await installSkill(rootDir, spec);
        if (scope === 'project') {
          const nextConfig = await addProjectSkill(rootDir, spec);
          setProjectConfig(nextConfig);
        }

        setSkillInstallProgress(current => ({
          total: nextSpecs.length,
          current: index + 1,
          currentLabel: spec.name,
          history: [
            ...(current?.history ?? []),
            `${spec.name} → ${scope} (${spec.target}) · ${spec.scope === 'global' ? displayPathFromHome(installation.targetDir, os.homedir()) : displayPath(installation.targetDir, rootDir)}`
          ].slice(-6)
        }));
      }

      await refreshInstalledSkills();
      setPendingSkillInstalls([]);
      setSelectedCatalogIds(new Set());
      setSkillCatalogEntries([]);
      setSkillInput('');
      setNotice(`Installed ${nextSpecs.length} skill${nextSpecs.length === 1 ? '' : 's'} successfully.`);
      setInstallError(null);
      setScreen('skills-menu');
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Unable to install the selected skills.');
      setScreen(scope === 'project' || scope === 'global' ? 'skill-scope' : 'skills-menu');
    } finally {
      setBusyMessage(null);
      setSkillInstallProgress(null);
    }
  };

  const applyBootstrapSelection = async (): Promise<void> => {
    const selectedIds = projectBootstrap.items.filter(item => item.selected).map(item => item.id);
    if (selectedIds.length === 0) {
      setScreen('home');
      return;
    }

    setBusyMessage('Applying project bootstrap...');
    setInstallError(null);
    setNotice(null);

    try {
      const inspection = await applyProjectBootstrap(rootDir, selectedIds);
      setProjectBootstrap(inspection);
      setNotice(`Created ${selectedIds.length} project bootstrap item${selectedIds.length === 1 ? '' : 's'}.`);
      setScreen('home');
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Unable to apply the project bootstrap.');
    } finally {
      setBusyMessage(null);
    }
  };

  const persistBacklog = async (prdPath: string, backlog: BacklogSnapshot, stateKey = sourceSlug(prdPath)): Promise<void> => {
    const paths = resolvePlanStatePaths(ralphDir, prdPath, stateKey);
    await ensureDir(paths.runDir);
    await saveBacklogSnapshot(paths.backlogPath, prdPath, deriveBranchName(prdPath), backlog);
  };

  const hydrateBacklogs = async (prdPaths: string[]): Promise<void> => {
    const entries = await Promise.all(
      prdPaths.map(async prdPath => {
        const paths = resolvePlanStatePaths(ralphDir, prdPath, sourceSlug(prdPath));
        const backlog = await ensureBacklog(prdPath, paths.prdJsonPath, paths.backlogPath).catch(() => null);
        return [prdPath, backlog] as const;
      })
    );

    setBacklogByPrd(current => ({
      ...current,
      ...Object.fromEntries(entries)
    }));
  };

  const openBacklogScreen = async (prdPaths: string[]): Promise<void> => {
    setBusyMessage('Preparing backlog view...');
    setNotice(null);
    try {
      await hydrateBacklogs(prdPaths);
      setBacklogCursor(0);
      setScreen('backlog');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to prepare the selected backlogs.');
    } finally {
      setBusyMessage(null);
    }
  };

  const updateBacklog = async (prdPath: string, nextBacklog: BacklogSnapshot): Promise<void> => {
    setBacklogByPrd(current => ({
      ...current,
      [prdPath]: nextBacklog
    }));
    await persistBacklog(prdPath, nextBacklog);
  };

  const handleRegenerateBacklog = async (prdPath: string): Promise<void> => {
    const paths = resolvePlanStatePaths(ralphDir, prdPath, sourceSlug(prdPath));
    const prdName = path.basename(prdPath);

    setNotice(null);

    try {
      let nextBacklog: BacklogSnapshot;

      if (selectedBacklogSkill) {
        await unlink(paths.backlogPath).catch(() => {});
        setBusyMessage(`Regenerating backlog with ${selectedBacklogSkill.name}...`);
        nextBacklog = await generateBacklogWithSkill({
          rootDir,
          ralphDir,
          sourcePrd: prdPath,
          skillName: selectedBacklogSkill.name,
          skillFilePath: selectedBacklogSkill.filePath,
          provider: activeProvider.value,
          onProgress: progress => {
            setBusyMessage(`Regenerating backlog with ${selectedBacklogSkill.name}... · ${progress}`);
          }
        });
      } else {
        setBusyMessage(`Regenerating backlog for ${prdName}...`);
        nextBacklog = await regenerateBacklog(prdPath, paths.prdJsonPath, paths.backlogPath);
      }

      setBacklogByPrd(current => ({
        ...current,
        [prdPath]: nextBacklog
      }));
      setNotice(`Regenerated backlog for ${prdName}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to regenerate the backlog.');
    } finally {
      setBusyMessage(null);
    }
  };

  const seedPlanBacklogs = async (nextPlans: RalphPrdPlan[]): Promise<void> => {
    await Promise.all(
      nextPlans.map(async plan => {
        const backlog = backlogByPrd[plan.sourcePrd];
        if (!backlog || !plan.backlogPath) {
          return;
        }

        const target = resolvePlanStatePaths(ralphDir, plan.sourcePrd, plan.stateKey);
        await ensureDir(target.runDir);
        await saveBacklogSnapshot(plan.backlogPath, plan.sourcePrd, plan.branchName ?? deriveBranchName(plan.sourcePrd), backlog);
      })
    );
  };

  const openSkillPicker = (purpose: SkillPurpose, context: 'create' | 'existing'): void => {
    setSkillPicker({ purpose, context });
    setSkillModeIndex(0);
    setDirectorySkillCursor(0);
    setScreen('skill-mode');
  };

  const buildBacklogPolicy = async (prdPaths: string[]): Promise<BacklogPolicyRow[]> => {
    const rows = await Promise.all(
      prdPaths.map(async prdPath => {
        const paths = resolvePlanStatePaths(ralphDir, prdPath, sourceSlug(prdPath));
        const hasExisting = await pathExists(paths.backlogPath);
        return {
          prdPath,
          hasExisting,
          mode: hasExisting ? 'reuse' : 'regenerate'
        } as BacklogPolicyRow;
      })
    );

    return rows;
  };

  const generateBacklogsFromPolicy = async (rows: BacklogPolicyRow[], skill: DiscoveredSkill): Promise<void> => {
    setBusyMessage(`Generating backlogs with ${skill.name}...`);
    setNotice(null);
    setBacklogBatchProgress(null);

    try {
      let completedCount = 0;
      let reusedCount = 0;
      let generatedCount = 0;
      const history: string[] = [];

      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const paths = resolvePlanStatePaths(ralphDir, row.prdPath, sourceSlug(row.prdPath));
        const statusPrefix = `${index + 1}/${rows.length}`;
        const baseBusyMessage =
          row.mode === 'reuse' && row.hasExisting
            ? `Reusing backlog ${statusPrefix}: ${path.basename(row.prdPath)}`
            : `Generating backlog ${statusPrefix}: ${path.basename(row.prdPath)}`;
        setBusyMessage(baseBusyMessage);
        setBacklogBatchProgress({
          total: rows.length,
          completed: completedCount,
          currentIndex: index + 1,
          currentPrdPath: row.prdPath,
          mode: row.mode,
          step: row.mode === 'reuse' && row.hasExisting ? 'Loading existing backlog' : 'Queued for generation',
          history: history.slice(-4)
        });

        let backlog: BacklogSnapshot | null = null;

        if (row.mode === 'reuse' && row.hasExisting) {
          setBacklogBatchProgress(current =>
            current
              ? {
                  ...current,
                  step: 'Loading existing backlog'
                }
              : current
          );
          backlog =
            (await loadBacklog(paths.backlogPath).catch(() => null)) ??
            (await ensureBacklog(row.prdPath, paths.prdJsonPath, paths.backlogPath).catch(() => null));

          if (!backlog) {
            backlog = await generateBacklogWithSkill({
              rootDir,
              ralphDir,
              sourcePrd: row.prdPath,
              skillName: skill.name,
              skillFilePath: skill.filePath,
              provider: activeProvider.value,
              onProgress: progress => {
                setBusyMessage(`${baseBusyMessage} · ${progress}`);
                setBacklogBatchProgress(current =>
                  current
                    ? {
                        ...current,
                        step: progress
                      }
                    : current
                );
              }
            });
            generatedCount += 1;
          } else {
            reusedCount += 1;
          }
        } else {
          backlog = await generateBacklogWithSkill({
            rootDir,
            ralphDir,
            sourcePrd: row.prdPath,
            skillName: skill.name,
            skillFilePath: skill.filePath,
            provider: activeProvider.value,
            onProgress: progress => {
              setBusyMessage(`${baseBusyMessage} · ${progress}`);
              setBacklogBatchProgress(current =>
                current
                  ? {
                      ...current,
                      step: progress
                    }
                  : current
              );
            }
          }).catch(error => {
            throw error;
          });
          generatedCount += 1;
        }

        setBacklogByPrd(current => ({
          ...current,
          [row.prdPath]: backlog
        }));

        completedCount += 1;
        history.push(`${statusPrefix} · ${path.basename(row.prdPath)} ready`);
        setBacklogBatchProgress(current =>
          current
            ? {
                ...current,
                completed: completedCount,
                step: 'Ready',
                history: history.slice(-4)
              }
            : current
        );
      }

      setBacklogPolicyRows(rows);
      setBacklogCursor(0);
      setScreen('backlog');
      setNotice(
        `Backlog ready for ${rows.length} PRD${rows.length === 1 ? '' : 's'}. Reused ${reusedCount} and generated ${generatedCount}.`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to generate the selected backlogs.');
    } finally {
      setBacklogBatchProgress(null);
      setBusyMessage(null);
    }
  };

  const beginExistingBacklogFlow = async (skill: DiscoveredSkill): Promise<void> => {
    const prdPaths = Array.from(selectedExistingPrds);
    if (prdPaths.length === 0) {
      setNotice('Pick at least one PRD before continuing.');
      return;
    }

    setSelectedBacklogSkill(skill);
    await generateBacklogsFromPolicy(await buildBacklogPolicy(prdPaths), skill);
  };

  const createDraftAndBacklog = async (backlogSkill: DiscoveredSkill): Promise<void> => {
    if (!selectedPrdSkill) {
      setNotice('Select a PRD skill before generating the draft.');
      return;
    }

    if (draftForm.title.trim().length < 3) {
      setNotice('Add a title before generating the PRD.');
      return;
    }

    if (draftForm.description.trim().length < 12) {
      setNotice('Describe the feature with a little more detail before continuing.');
      return;
    }

    setBusyMessage(`Creating PRD with ${selectedPrdSkill.name}...`);
    setNotice(null);
    try {
      const draftPath = await createPrdDraftFromBrief(
        rootDir,
        {
          title: draftForm.title,
          description: draftForm.description
        },
        {
          skillName: selectedPrdSkill.name,
          skillFilePath: selectedPrdSkill.filePath,
          provider: activeProvider.value,
          onProgress: progress => {
            setBusyMessage(`Creating PRD with ${selectedPrdSkill.name}... · ${progress}`);
          }
        }
      );

      setBusyMessage(`Generating backlog with ${backlogSkill.name}...`);
      const backlog = await generateBacklogWithSkill({
        rootDir,
        ralphDir,
        sourcePrd: draftPath,
        skillName: backlogSkill.name,
        skillFilePath: backlogSkill.filePath,
        provider: activeProvider.value,
        onProgress: progress => {
          setBusyMessage(`Generating backlog with ${backlogSkill.name}... · ${progress}`);
        }
      });

      setBacklogByPrd(current => ({
        ...current,
        [draftPath]: backlog
      }));
      setCreatedDrafts(current => [
        ...current,
        {
          path: draftPath,
          title: draftForm.title.trim(),
          prdSkillName: selectedPrdSkill.name,
          backlogSkillName: backlogSkill.name
        }
      ]);
      setDraftForm({
        title: '',
        description: '',
        field: 'title',
        fullscreen: false
      });
      setBriefCreatedIndex(0);
      setScreen('brief-created');
      setNotice(`Created ${path.basename(draftPath)} and generated its backlog.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to create the draft PRD.');
    } finally {
      setBusyMessage(null);
    }
  };

  const applySkillChoice = async (skill: DiscoveredSkill): Promise<void> => {
    if (!skillPicker) {
      return;
    }

    if (skillPicker.purpose === 'prd') {
      setSelectedPrdSkill(skill);
      setSkillPicker({
        purpose: 'backlog',
        context: 'create'
      });
      setSkillModeIndex(0);
      setScreen('skill-mode');
      return;
    }

    setSelectedBacklogSkill(skill);
    setSkillPicker(null);

    if (skillPicker.context === 'create') {
      await createDraftAndBacklog(skill);
      return;
    }

    await beginExistingBacklogFlow(skill);
  };

  const openPrdViewer = async (prdPath: string, returnScreen: 'backlog' | 'review'): Promise<void> => {
    setBusyMessage(`Loading ${path.basename(prdPath)}...`);
    setNotice(null);

    try {
      const document = await loadPrdDocument(prdPath);
      setViewer({
        kind: 'prd',
        title: path.basename(prdPath),
        subtitle: document.kind.toUpperCase(),
        lines: buildPrdViewerLines(path.basename(prdPath), document.content),
        scroll: 0,
        returnScreen
      });
      setScreen('prd-view');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to load the PRD.');
    } finally {
      setBusyMessage(null);
    }
  };

  const openBacklogViewer = (row: BacklogRow, returnScreen: 'backlog' | 'review'): void => {
    if (row.kind !== 'item') {
      setNotice('Select a backlog item to view its details.');
      return;
    }

    setViewer({
      kind: 'backlog',
      title: row.label.trim(),
      subtitle: path.basename(row.prdPath),
      lines: buildBacklogViewerLines(row, backlogByPrd[row.prdPath] ?? null),
      scroll: 0,
      returnScreen
    });
    setScreen('backlog-view');
  };

  const openPrdEditor = async (prdPath: string, returnScreen: 'backlog' | 'review'): Promise<void> => {
    setBusyMessage(`Loading ${path.basename(prdPath)}...`);
    setNotice(null);

    try {
      const document = await loadPrdDocument(prdPath);
      setPrdEditor({
        prdPath,
        title: document.title,
        description: document.description,
        field: 'title',
        fullscreen: false,
        returnScreen
      });
      setScreen('prd-edit');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to load the PRD for editing.');
    } finally {
      setBusyMessage(null);
    }
  };

  const savePrdEdit = async (editor: PrdEditorState): Promise<void> => {
    if (!editor.title.trim()) {
      setNotice('A PRD needs at least a title.');
      return;
    }

    setBusyMessage(`Saving ${path.basename(editor.prdPath)}...`);
    setNotice(null);

    try {
      await savePrdDocument(editor.prdPath, {
        title: editor.title,
        description: editor.description
      });

      if (selectedBacklogSkill) {
        setBusyMessage(`Refreshing backlog with ${selectedBacklogSkill.name}...`);
        const refreshed = await generateBacklogWithSkill({
          rootDir,
          ralphDir,
          sourcePrd: editor.prdPath,
          skillName: selectedBacklogSkill.name,
          skillFilePath: selectedBacklogSkill.filePath,
          provider: activeProvider.value,
          onProgress: progress => {
            setBusyMessage(`Refreshing backlog with ${selectedBacklogSkill.name}... · ${progress}`);
          }
        });

        setBacklogByPrd(current => ({
          ...current,
          [editor.prdPath]: refreshed
        }));
      } else {
        await hydrateBacklogs([editor.prdPath]);
      }

      setPrdEditor(null);
      setScreen(editor.returnScreen);
      setNotice(`Saved ${path.basename(editor.prdPath)}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to save the PRD.');
    } finally {
      setBusyMessage(null);
    }
  };

  const updateDependencySelection = (prdPath: string, dependencyPath: string | null): void => {
    const currentPlans = buildPlans(ralphDir, selectedPrdPaths, iterationValues, activeSchedule.value, singlePrdVariantCount, dependencyValues);
    const planId = sourceSlug(prdPath);
    const nextDependsOn = dependencyPath ? sourceSlug(dependencyPath) : null;

    if (wouldCreateDependencyCycle(currentPlans, planId, nextDependsOn)) {
      setNotice('Dependencies cannot create a cycle.');
      return;
    }

    const nextValues = {
      ...dependencyValues,
      [prdPath]: dependencyPath
    };

    try {
      validatePlanDependencies(
        buildPlans(ralphDir, selectedPrdPaths, iterationValues, activeSchedule.value, singlePrdVariantCount, nextValues)
      );
      setDependencyValues(nextValues);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to update the PRD dependency.');
    }
  };

  const finalizeConfig = async (): Promise<void> => {
    const nextPlans = buildPlans(ralphDir, selectedPrdPaths, iterationValues, activeSchedule.value, singlePrdVariantCount, dependencyValues);
    if (nextPlans.length === 0) {
      setNotice('Select at least one PRD before continuing.');
      return;
    }

    if (activeSchedule.value === 'parallel' && selectedPrdPaths.length === 1 && singlePrdVariantCount < 2) {
      setNotice('Parallel single-PRD runs require at least two versions.');
      return;
    }

    try {
      validatePlanDependencies(nextPlans);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to validate the PRD dependencies.');
      return;
    }

    setBusyMessage('Seeding launch state...');
    setNotice(null);
    try {
      const nextConfig = {
        ...reviewConfig,
        plans: nextPlans,
        maxIterations: Math.max(...nextPlans.map(plan => plan.iterations), 1)
      };
      const doctorReport = await runDoctor(nextConfig);
      setLaunchDoctorReport(doctorReport);
      if (doctorReport.status === 'blocking') {
        setNotice(`Preflight blockers found. ${doctorSummaryLine(doctorReport)}.`);
        return;
      }

      await saveProjectConfig(rootDir, reviewProjectConfig);
      setProjectConfig(reviewProjectConfig);
      await seedPlanBacklogs(nextPlans);
      onComplete(nextConfig);
      exit();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to finalize the launch plan.');
    } finally {
      setBusyMessage(null);
    }
  };

  useInput((input, key) => {
    const textEntryScreen = screenBlocksCharacterShortcuts(screen);

    if (!textEntryScreen && (input === 'g' || input === 'G')) {
      setArcadeOpen(current => !current);
      return;
    }

    if (arcadeOpen) {
      return;
    }

    if (busyMessage) {
      return;
    }

    if ((!textEntryScreen && (input === 'q' || input === 'Q')) || key.escape) {
      if (
        screen === 'bootstrap' ||
        screen === 'skills-menu' ||
        screen === 'skill-catalog' ||
        screen === 'skill-input' ||
        screen === 'skill-target' ||
        screen === 'skill-scope' ||
        screen === 'skill-progress' ||
        screen === 'skill-mode' ||
        screen === 'skill-directory' ||
        screen === 'backlog-policy'
      ) {
        setInstallError(null);
        setScreen(screen === 'bootstrap' ? 'home' : 'home');
        return;
      }

      if (screen === 'backlog-edit') {
        setBacklogEditor(null);
        setScreen(backlogEditor?.returnScreen ?? 'backlog');
        return;
      }

      if (screen === 'prd-edit') {
        setPrdEditor(null);
        setScreen(prdEditor?.returnScreen ?? 'backlog');
        return;
      }

      if (screen === 'backlog-view' || screen === 'prd-view' || screen === 'skill-view' || screen === 'bootstrap-view') {
        setViewer(null);
        setScreen(viewer?.returnScreen ?? 'backlog');
        return;
      }

      onCancel();
      exit();
      return;
    }

    if (key.leftArrow) {
      setNotice(null);
      setInstallError(null);

      if (screen === 'prds' || screen === 'brief') {
        setScreen('provider-skills');
      } else if (screen === 'about') {
        setScreen('home');
      } else if (screen === 'bootstrap') {
        setScreen('home');
      } else if (screen === 'skill-mode') {
        if (skillPicker?.context === 'create' && skillPicker.purpose === 'backlog') {
          setSkillPicker({ purpose: 'prd', context: 'create' });
        } else {
          setSkillPicker(null);
          setScreen(skillPicker?.context === 'create' ? 'brief' : 'prds');
          return;
        }
      } else if (screen === 'skill-directory') {
        setScreen('skill-mode');
      } else if (screen === 'backlog-policy') {
        setScreen('prds');
      } else if (screen === 'brief-created') {
        setScreen('brief');
      } else if (screen === 'backlog') {
        setScreen(activeHome.value === 'create-prd' ? 'brief-created' : 'prds');
      } else if (screen === 'dependencies') {
        setScreen('backlog');
      } else if (screen === 'backlog-edit') {
        setBacklogEditor(null);
        setScreen(backlogEditor?.returnScreen ?? 'backlog');
      } else if (screen === 'prd-edit') {
        setPrdEditor(null);
        setScreen(prdEditor?.returnScreen ?? 'backlog');
      } else if (screen === 'backlog-view' || screen === 'prd-view' || screen === 'skill-view' || screen === 'bootstrap-view') {
        setViewer(null);
        setScreen(viewer?.returnScreen ?? 'backlog');
      } else if (screen === 'notifications') {
        setScreen('home');
      } else if (screen === 'notification-events' || screen === 'notification-channels') {
        setScreen('notifications');
      } else if (screen === 'notification-edit') {
        setNotificationEditChannel(null);
        setScreen('notification-channels');
      } else if (screen === 'cleanup-confirm') {
        setCleanupInput('');
        setScreen('home');
      } else if (screen === 'provider') {
        setScreen('home');
      } else if (screen === 'environment') {
        setScreen(selectedPrdPaths.length > 1 ? 'dependencies' : 'backlog');
      } else if (screen === 'provider-skills') {
        setScreen('provider');
      } else if (screen === 'provider-skill-action') {
        setProviderSkillDecision(null);
        setScreen('provider-skills');
      } else if (screen === 'schedule') {
        setScreen('environment');
      } else if (screen === 'iterations') {
        setScreen('schedule');
      } else if (screen === 'token-budget') {
        setScreen('iterations');
      } else if (screen === 'review') {
        setScreen('token-budget');
      } else if (screen === 'skill-catalog') {
        setScreen('skills-menu');
      } else if (screen === 'skill-input') {
        setScreen('skills-menu');
      } else if (screen === 'skill-target') {
        setScreen('skill-input');
      } else if (screen === 'skill-scope') {
        setScreen(skillSource === 'github' ? 'skill-target' : 'skill-catalog');
      } else if (screen === 'skill-progress') {
        setScreen('skill-scope');
      }
      return;
    }

    if (screen === 'bootstrap') {
      if (key.upArrow) {
        setBootstrapCursor(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setBootstrapCursor(current => Math.min(Math.max(projectBootstrap.items.length - 1, 0), current + 1));
      } else if ((input === ' ' || input === '\t') && activeBootstrapItem) {
        setProjectBootstrap(current => ({
          ...current,
          items: current.items.map((item, index) =>
            index === bootstrapCursor
              ? {
                  ...item,
                  selected: !item.selected
                }
              : item
          )
        }));
      } else if ((input === 'v' || input === 'V') && activeBootstrapItem) {
        openBootstrapPreview(activeBootstrapItem);
      } else if (input === 's' || input === 'S') {
        setScreen('home');
      } else if (key.return) {
        void applyBootstrapSelection();
      }
      return;
    }

    if (screen === 'resume-run') {
      if (key.upArrow) {
        setPendingRunIndex(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setPendingRunIndex(current => Math.min(pendingRunOptions.length - 1, current + 1));
      } else if (key.return) {
        void applyPendingRunChoice(pendingRunOptions[pendingRunIndex]?.value ?? 'continue');
      }
      return;
    }

    if (screen === 'home') {
      if (key.upArrow) {
        setHomeIndex(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setHomeIndex(current => Math.min(homeOptions.length - 1, current + 1));
      } else if (key.return) {
        setNotice(null);
        if (activeHome.value === 'bootstrap') {
          setScreen('bootstrap');
        } else if (activeHome.value === 'notifications') {
          setNotificationMenuCursor(0);
          setScreen('notifications');
        } else if (activeHome.value === 'manage-skills') {
          setScreen('skills-menu');
        } else if (activeHome.value === 'cleanup') {
          void openCleanupScreen();
        } else if (activeHome.value === 'about') {
          setScreen('about');
        } else {
          setScreen('provider');
        }
      }
      return;
    }

    if (screen === 'notifications') {
      if (key.upArrow) {
        setNotificationMenuCursor(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setNotificationMenuCursor(current => Math.min(notificationMenuOptions.length - 1, current + 1));
      } else if (key.return) {
        setScreen(activeNotificationMenu.value === 'events' ? 'notification-events' : 'notification-channels');
      }
      return;
    }

    if (screen === 'notification-events') {
      if (key.upArrow) {
        setNotificationEventCursor(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setNotificationEventCursor(current => Math.min(notificationEventRows.length - 1, current + 1));
      } else if ((input === ' ' || key.return) && activeNotificationEventRow) {
        void toggleNotificationEvent(activeNotificationEventRow.event);
      }
      return;
    }

    if (screen === 'notification-channels') {
      if (key.upArrow) {
        setNotificationChannelCursor(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setNotificationChannelCursor(current => Math.min(notificationChannelRows.length - 1, current + 1));
      } else if (key.return && activeNotificationChannelRow) {
        openNotificationEditor(activeNotificationChannelRow.channel);
      } else if (input === ' ' && activeNotificationChannelRow) {
        void toggleNotificationChannel(activeNotificationChannelRow.channel);
      }
      return;
    }

    if (screen === 'notification-edit') {
      if (key.return) {
        void saveNotificationChannelInput();
        return;
      }

      if (key.backspace || key.delete) {
        setNotificationUrlInput(current => current.slice(0, -1));
        return;
      }

      if (isPrintableInput(input)) {
        setNotificationUrlInput(current => `${current}${input}`);
      }
      return;
    }

    if (screen === 'cleanup-confirm') {
      if (key.return) {
        void runCleanupNow();
        return;
      }

      if (key.backspace || key.delete) {
        setCleanupInput(current => current.slice(0, -1));
        return;
      }

      if (isPrintableInput(input)) {
        setCleanupInput(current => `${current}${input.toUpperCase()}`);
      }
      return;
    }

    if (screen === 'prds') {
      if (key.upArrow) {
        setPrdCursor(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setPrdCursor(current => Math.min(prdOptions.length - 1, current + 1));
      } else if (input === ' ' || input === '\t') {
        const currentPrd = prdOptions[prdCursor];
        if (!currentPrd) {
          return;
        }

        setSelectedExistingPrds(current => {
          const next = new Set(current);
          if (next.has(currentPrd)) {
            next.delete(currentPrd);
          } else {
            next.add(currentPrd);
          }
          return next;
        });
      } else if (key.return) {
        if (selectedExistingPrds.size === 0) {
          setNotice('Pick at least one PRD before continuing.');
          return;
        }

        openSkillPicker('backlog', 'existing');
      }
      return;
    }

    if (screen === 'brief') {
      if (key.ctrl && (input === 'f' || input === 'F')) {
        setDraftForm(current => ({
          ...current,
          fullscreen: !current.fullscreen
        }));
        return;
      }

      if (key.tab) {
        setDraftForm(current => ({
          ...current,
          field: current.field === 'title' ? 'description' : 'title'
        }));
        return;
      }

      if (key.return && !key.shift) {
        if (draftForm.title.trim().length < 3) {
          setNotice('Add a title before continuing.');
          return;
        }

        if (draftForm.description.trim().length < 12) {
          setNotice('Describe the feature with a little more detail before continuing.');
          return;
        }

        openSkillPicker('prd', 'create');
        return;
      }

      if (key.return && key.shift && draftForm.field === 'description') {
        setDraftForm(current => ({
          ...current,
          description: `${current.description}\n`
        }));
        return;
      }

      if (key.backspace || key.delete) {
        setDraftForm(current =>
          current.field === 'title'
            ? {
                ...current,
                title: current.title.slice(0, -1)
              }
            : {
                ...current,
                description: current.description.slice(0, -1)
              }
        );
        return;
      }

      if (isPrintableInput(input) || (input === '\n' && draftForm.field === 'description')) {
        setDraftForm(current =>
          current.field === 'title'
            ? {
                ...current,
                title: `${current.title}${input === '\n' ? '' : input}`
              }
            : {
                ...current,
                description: `${current.description}${input}`
              }
        );
      }
      return;
    }

    if (screen === 'skill-mode') {
      if (key.upArrow) {
        setSkillModeIndex(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setSkillModeIndex(current => Math.min(skillModeOptions.length - 1, current + 1));
      } else if (key.return) {
        const option = skillModeOptions[skillModeIndex]?.value ?? 'builtin';
        if (option === 'directory') {
          if (directorySkills.length === 0) {
            setNotice('No project or global provider skills were found.');
            return;
          }

          setDirectorySkillCursor(0);
          setScreen('skill-directory');
          return;
        }

        void applySkillChoice(skillPicker?.purpose === 'backlog' ? builtinBacklogSkill : builtinPrdSkill);
      }
      return;
    }

    if (screen === 'skill-directory') {
      if (key.upArrow) {
        setDirectorySkillCursor(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setDirectorySkillCursor(current => Math.min(Math.max(directorySkills.length - 1, 0), current + 1));
      } else if (key.return) {
        if (!activeDirectorySkill) {
          setNotice('No provider skill is available to select.');
          return;
        }

        void applySkillChoice(activeDirectorySkill);
      }
      return;
    }

    if (screen === 'backlog-policy') {
      if (key.upArrow) {
        setBacklogPolicyCursor(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setBacklogPolicyCursor(current => Math.min(Math.max(backlogPolicyRows.length - 1, 0), current + 1));
      } else if ((input === ' ' || input === '\t' || key.rightArrow) && activeBacklogPolicyRow?.hasExisting) {
        setBacklogPolicyRows(current =>
          current.map((row, index) =>
            index === backlogPolicyCursor
              ? {
                  ...row,
                  mode: row.mode === 'reuse' ? 'regenerate' : 'reuse'
                }
              : row
          )
        );
      } else if (key.return) {
        if (!selectedBacklogSkill) {
          setNotice('Select a backlog skill before continuing.');
          return;
        }

        void generateBacklogsFromPolicy(backlogPolicyRows, selectedBacklogSkill);
      }
      return;
    }

    if (screen === 'brief-created') {
      if (key.upArrow) {
        setBriefCreatedIndex(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setBriefCreatedIndex(current => Math.min(briefCreatedOptions.length - 1, current + 1));
      } else if (key.return) {
        const action = briefCreatedOptions[briefCreatedIndex]?.value ?? 'continue';
        if (action === 'create-another') {
          setScreen('brief');
        } else {
          void openBacklogScreen(selectedPrdPaths);
        }
      }
      return;
    }

    if (screen === 'backlog') {
      const activeRow = backlogRowsAll[backlogCursor] ?? null;
      if (key.upArrow) {
        setBacklogCursor(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setBacklogCursor(current => Math.min(Math.max(backlogRowsAll.length - 1, 0), current + 1));
      } else if ((input === 'a' || input === 'A') && activeRow) {
        setBacklogEditor({
          mode: 'add',
          prdPath: activeRow.prdPath,
          itemId: null,
          title: '',
          description: '',
          field: 'title',
          fullscreen: false,
          returnScreen: 'backlog'
        });
        setScreen('backlog-edit');
      } else if ((input === 'e' || input === 'E') && activeRow?.kind === 'item' && activeRow.itemId) {
        const item = backlogByPrd[activeRow.prdPath]?.items.find(entry => entry.id === activeRow.itemId);
        if (!item) {
          setNotice('Select a backlog item before editing.');
          return;
        }

        setBacklogEditor({
          mode: 'edit',
          prdPath: activeRow.prdPath,
          itemId: item.id,
          title: item.title,
          description: item.description,
          field: 'title',
          fullscreen: false,
          returnScreen: 'backlog'
        });
        setScreen('backlog-edit');
      } else if ((input === 'p' || input === 'P') && activeRow) {
        void openPrdViewer(activeRow.prdPath, 'backlog');
      } else if ((input === 'r' || input === 'R') && activeRow) {
        void openPrdEditor(activeRow.prdPath, 'backlog');
      } else if ((input === 'v' || input === 'V') && activeRow) {
        openBacklogViewer(activeRow, 'backlog');
      } else if ((input === 'x' || input === 'X') && activeRow?.kind === 'item' && activeRow.itemId) {
        const backlog = backlogByPrd[activeRow.prdPath];
        if (!backlog) {
          return;
        }
        const nextBacklog = removeBacklogItem(backlog, activeRow.itemId);
        void updateBacklog(activeRow.prdPath, nextBacklog).catch(error => {
          setNotice(error instanceof Error ? error.message : 'Unable to remove the backlog item.');
        });
      } else if ((input === 'd' || input === 'D') && activeRow?.kind === 'item' && activeRow.itemId) {
        const backlog = backlogByPrd[activeRow.prdPath];
        const item = backlog?.items.find(entry => entry.id === activeRow.itemId);
        if (!backlog || !item) {
          return;
        }
        const nextStatus: BacklogStatus = item.status === 'disabled' ? 'pending' : 'disabled';
        const nextBacklog = setBacklogItemStatus(backlog, activeRow.itemId, nextStatus);
        void updateBacklog(activeRow.prdPath, nextBacklog).catch(error => {
          setNotice(error instanceof Error ? error.message : 'Unable to update the backlog item.');
        });
      } else if ((input === 'c' || input === 'C') && activeRow?.kind === 'item' && activeRow.itemId) {
        const backlog = backlogByPrd[activeRow.prdPath];
        const item = backlog?.items.find(entry => entry.id === activeRow.itemId);
        if (!backlog || !item) {
          return;
        }
        const nextStatus: BacklogStatus = item.status === 'done' ? 'pending' : 'done';
        const nextBacklog = setBacklogItemStatus(backlog, activeRow.itemId, nextStatus);
        void updateBacklog(activeRow.prdPath, nextBacklog).catch(error => {
          setNotice(error instanceof Error ? error.message : 'Unable to update the backlog item.');
        });
      } else if (key.return) {
        if (activeRow?.kind === 'action') {
          void handleRegenerateBacklog(activeRow.prdPath);
          return;
        }

        if (selectedPrdPaths.length === 0) {
          setNotice('Pick at least one PRD before continuing.');
          return;
        }

        setScreen(selectedPrdPaths.length > 1 ? 'dependencies' : 'environment');
      }
      return;
    }

    if (screen === 'dependencies') {
      if (key.upArrow) {
        setDependencyCursor(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setDependencyCursor(current => Math.min(Math.max(dependencyRowsAll.length - 1, 0), current + 1));
      } else if (key.leftArrow || input === '-' || key.backspace || key.delete) {
        if (activeDependencyRow) {
          const options = [null, ...selectedPrdPaths.filter(prdPath => prdPath !== activeDependencyRow.prdPath)];
          const currentIndex = Math.max(0, options.findIndex(option => option === (dependencyValues[activeDependencyRow.prdPath] ?? null)));
          const nextIndex = (currentIndex - 1 + options.length) % options.length;
          updateDependencySelection(activeDependencyRow.prdPath, options[nextIndex] ?? null);
        }
      } else if (key.rightArrow || input === '+' || input === ' ' || input === '	') {
        if (activeDependencyRow) {
          const options = [null, ...selectedPrdPaths.filter(prdPath => prdPath !== activeDependencyRow.prdPath)];
          const currentIndex = Math.max(0, options.findIndex(option => option === (dependencyValues[activeDependencyRow.prdPath] ?? null)));
          const nextIndex = (currentIndex + 1) % options.length;
          updateDependencySelection(activeDependencyRow.prdPath, options[nextIndex] ?? null);
        }
      } else if (key.return) {
        try {
          validatePlanDependencies(plans);
          setScreen('environment');
        } catch (error) {
          setNotice(error instanceof Error ? error.message : 'Unable to validate the PRD dependencies.');
        }
      }
      return;
    }

    if (screen === 'skill-view') {
      if (!viewer) {
        setScreen(skillSource === 'github' ? 'skill-input' : 'skill-catalog');
        return;
      }

      if (key.upArrow) {
        setViewer(current =>
          current
            ? {
                ...current,
                scroll: Math.max(0, current.scroll - 1)
              }
            : current
        );
      } else if (key.downArrow) {
        setViewer(current =>
          current
            ? {
                ...current,
                scroll: Math.min(Math.max(current.lines.length - viewerRows, 0), current.scroll + 1)
              }
            : current
        );
      } else if (key.return) {
        const nextScreen = viewer.returnScreen === 'skill-input' ? 'skill-target' : viewer.returnScreen;
        setViewer(null);
        setScreen(nextScreen);
      }
      return;
    }

    if (screen === 'backlog-view' || screen === 'prd-view' || screen === 'bootstrap-view') {
      if (!viewer) {
        setScreen(screen === 'bootstrap-view' ? 'bootstrap' : 'backlog');
        return;
      }

      if (key.upArrow) {
        setViewer(current =>
          current
            ? {
                ...current,
                scroll: Math.max(0, current.scroll - 1)
              }
            : current
        );
      } else if (key.downArrow) {
        setViewer(current =>
          current
            ? {
                ...current,
                scroll: Math.min(Math.max(current.lines.length - viewerRows, 0), current.scroll + 1)
              }
            : current
        );
      } else if (key.return) {
        setViewer(null);
        setScreen(viewer.returnScreen);
      }
      return;
    }

    if (screen === 'prd-edit') {
      if (!prdEditor) {
        setScreen('backlog');
        return;
      }

      if (key.tab) {
        setPrdEditor(current =>
          current
            ? {
                ...current,
                field: current.field === 'title' ? 'description' : 'title'
              }
            : current
        );
        return;
      }

      if (key.ctrl && (input === 'f' || input === 'F')) {
        setPrdEditor(current =>
          current
            ? {
                ...current,
                fullscreen: !current.fullscreen
              }
            : current
        );
        return;
      }

      if (key.return && !key.shift) {
        void savePrdEdit(prdEditor);
        return;
      }

      if (key.return && key.shift && prdEditor.field === 'description') {
        setPrdEditor(current =>
          current
            ? {
                ...current,
                description: `${current.description}\n`
              }
            : current
        );
        return;
      }

      if (key.backspace || key.delete) {
        setPrdEditor(current =>
          current
            ? current.field === 'title'
              ? {
                  ...current,
                  title: current.title.slice(0, -1)
                }
              : {
                  ...current,
                  description: current.description.slice(0, -1)
                }
            : current
        );
        return;
      }

      if (isPrintableInput(input) || (input === '\n' && prdEditor.field === 'description')) {
        setPrdEditor(current =>
          current
            ? current.field === 'title'
              ? {
                  ...current,
                  title: `${current.title}${input === '\n' ? '' : input}`
                }
              : {
                  ...current,
                  description: `${current.description}${input}`
                }
            : current
        );
      }
      return;
    }

    if (screen === 'backlog-edit') {
      if (!backlogEditor) {
        setScreen('backlog');
        return;
      }

      if (key.tab) {
        setBacklogEditor(current =>
          current
            ? {
                ...current,
                field: current.field === 'title' ? 'description' : 'title'
              }
            : current
        );
        return;
      }

      if (key.ctrl && (input === 'f' || input === 'F')) {
        setBacklogEditor(current =>
          current
            ? {
                ...current,
                fullscreen: !current.fullscreen
              }
            : current
        );
        return;
      }

      if (key.return && !key.shift) {
        const backlog = backlogByPrd[backlogEditor.prdPath];
        if (!backlog) {
          setNotice('Backlog not loaded yet.');
          return;
        }

        const trimmedTitle = backlogEditor.title.trim();
        if (!trimmedTitle) {
          setNotice('A backlog item needs at least a title.');
          return;
        }

        const nextBacklog =
          backlogEditor.mode === 'add'
            ? addBacklogItem(backlog, trimmedTitle, backlogEditor.description)
            : editBacklogItem(backlog, backlogEditor.itemId ?? '', {
                title: trimmedTitle,
                description: backlogEditor.description
              });

        setBacklogEditor(null);
        setScreen(backlogEditor.returnScreen);
        void updateBacklog(backlogEditor.prdPath, nextBacklog).catch(error => {
          setNotice(error instanceof Error ? error.message : 'Unable to save the backlog item.');
        });
        return;
      }

      if (key.return && key.shift && backlogEditor.field === 'description') {
        setBacklogEditor(current =>
          current
            ? {
                ...current,
                description: `${current.description}\n`
              }
            : current
        );
        return;
      }

      if (key.backspace || key.delete) {
        setBacklogEditor(current =>
          current
            ? current.field === 'title'
              ? {
                  ...current,
                  title: current.title.slice(0, -1)
                }
              : {
                  ...current,
                  description: current.description.slice(0, -1)
                }
            : current
        );
        return;
      }

      if (isPrintableInput(input) || (input === '\n' && backlogEditor.field === 'description')) {
        setBacklogEditor(current =>
          current
            ? current.field === 'title'
              ? {
                  ...current,
                  title: `${current.title}${input === '\n' ? '' : input}`
                }
              : {
                  ...current,
                  description: `${current.description}${input}`
                }
            : current
        );
      }
      return;
    }

    if (screen === 'provider') {
      if (key.upArrow) {
        setProviderIndex(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setProviderIndex(current => Math.min(providerOptions.length - 1, current + 1));
      } else if (key.return) {
        if (!activeProviderHasNativeSkills) {
          setScreen(entryWorkScreen);
          return;
        }

        const firstSkillIndex = providerSkillRows.findIndex(row => row.kind === 'skill');
        setProviderSkillCursor(firstSkillIndex === -1 ? 0 : firstSkillIndex);
        setScreen('provider-skills');
      }
      return;
    }

    if (screen === 'provider-skills') {
      if (key.upArrow) {
        setProviderSkillCursor(current => nextProviderSkillCursor(providerSkillRows, current, -1));
      } else if (key.downArrow) {
        setProviderSkillCursor(current => nextProviderSkillCursor(providerSkillRows, current, 1));
      } else if ((input === ' ' || key.tab) && activeProviderSkill) {
        toggleProviderSkillSelection(activeProviderSkill);
      } else if ((input === 'v' || input === 'V') && activeProviderSkill) {
        void openProviderSkillPreview(activeProviderSkill);
      } else if (key.return) {
        setScreen(entryWorkScreen);
      }
      return;
    }

    if (screen === 'provider-skill-action') {
      if (key.upArrow) {
        setProviderSkillActionIndex(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setProviderSkillActionIndex(current => Math.min(providerSkillDecisionOptions.length - 1, current + 1));
      } else if (key.return) {
        void applyProviderSkillDecision(providerSkillDecisionOptions[providerSkillActionIndex]?.value ?? 'session');
      }
      return;
    }

    if (screen === 'environment') {
      if (key.upArrow) {
        setEnvironmentIndex(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setEnvironmentIndex(current => Math.min(Math.max(availableEnvironmentOptions.length - 1, 0), current + 1));
      } else if (key.return) {
        setIterationCursor(0);
        setScreen('schedule');
      }
      return;
    }

    if (screen === 'schedule') {
      if (key.upArrow) {
        setScheduleIndex(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setScheduleIndex(current => Math.min(scheduleOptions.length - 1, current + 1));
      } else if (key.return) {
        setIterationCursor(0);
        setScreen('iterations');
      }
      return;
    }

    if (screen === 'iterations') {
      const activeEntry = iterationEntries[iterationCursor];
      if (!activeEntry) {
        return;
      }

      const increaseValue = (): void => {
        if (activeEntry.kind === 'variant-count') {
          setSinglePrdVariantCount(current => Math.min(12, current + 1));
          return;
        }

        setIterationValues(current => ({
          ...current,
          [activeEntry.key]: String(Math.min(999, Math.max(1, Number(current[activeEntry.key] ?? '1')) + 1))
        }));
      };

      const decreaseValue = (): void => {
        if (activeEntry.kind === 'variant-count') {
          setSinglePrdVariantCount(current => Math.max(2, current - 1));
          return;
        }

        setIterationValues(current => ({
          ...current,
          [activeEntry.key]: String(Math.max(1, Number(current[activeEntry.key] ?? '1') - 1))
        }));
      };

      if (key.upArrow) {
        setIterationCursor(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setIterationCursor(current => Math.min(Math.max(iterationEntries.length - 1, 0), current + 1));
      } else if (input === '+' || key.rightArrow) {
        increaseValue();
      } else if (input === '-' || input === '_') {
        decreaseValue();
      } else if ((key.backspace || key.delete) && activeEntry.kind === 'plan') {
        setIterationValues(current => ({
          ...current,
          [activeEntry.key]: (current[activeEntry.key] ?? '').slice(0, -1)
        }));
      } else if (isPrintableInput(input) && /^[0-9]$/.test(input)) {
        if (activeEntry.kind === 'variant-count') {
          const nextValue = Number(`${singlePrdVariantCount}${input}`.slice(-2));
          setSinglePrdVariantCount(Math.max(2, Math.min(12, nextValue || 2)));
          return;
        }

        setIterationValues(current => ({
          ...current,
          [activeEntry.key]: `${current[activeEntry.key] ?? ''}${input}`.replace(/^0+/, '').slice(0, 3) || input
        }));
      } else if (key.return) {
        const planValues = iterationEntries
          .filter(entry => entry.kind === 'plan')
          .map(entry => Number(iterationValues[entry.key] ?? '0'));
        if (planValues.some(value => !Number.isInteger(value) || value < 1)) {
          setNotice('All PRD pass budgets must be positive integers.');
          return;
        }

        if (activeSchedule.value === 'parallel' && selectedPrdPaths.length === 1 && singlePrdVariantCount < 2) {
          setNotice('Parallel single-PRD runs require at least two versions.');
          return;
        }

        setScreen('token-budget');
      }
      return;
    }

    if (screen === 'token-budget') {
      if (input === ' ' || key.tab) {
        setTokenBudgetEnabled(current => !current);
        return;
      }

      if (tokenBudgetEnabled && (key.backspace || key.delete)) {
        setTokenBudgetInput(current => current.slice(0, -1));
        return;
      }

      if (tokenBudgetEnabled && isPrintableInput(input) && /^[0-9]$/.test(input)) {
        setTokenBudgetInput(current => `${current}${input}`.replace(/^0+/, '').slice(0, 9) || input);
        return;
      }

      if (key.return) {
        if (tokenBudgetEnabled && parsedTokenBudget === null) {
          setNotice('The execution token limit must be a positive integer.');
          return;
        }

        setScreen('review');
      }
      return;
    }

    if (screen === 'review') {
      const activeRow = backlogRowsAll[backlogCursor] ?? null;
      if (key.upArrow) {
        setBacklogCursor(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setBacklogCursor(current => Math.min(Math.max(backlogRowsAll.length - 1, 0), current + 1));
      } else if ((input === 'p' || input === 'P') && activeRow) {
        void openPrdViewer(activeRow.prdPath, 'review');
      } else if ((input === 'r' || input === 'R') && activeRow) {
        void openPrdEditor(activeRow.prdPath, 'review');
      } else if ((input === 'v' || input === 'V') && activeRow) {
        openBacklogViewer(activeRow, 'review');
      } else if (key.return) {
        void finalizeConfig();
      }
      return;
    }

    if (screen === 'skills-menu') {
      if (key.upArrow) {
        setSkillMenuIndex(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setSkillMenuIndex(current => Math.min(skillMenuOptions.length - 1, current + 1));
      } else if (key.return) {
        if (activeSkillMenu.value === 'back') {
          setScreen('home');
        } else {
          void loadSkillCatalog(activeSkillMenu.value);
        }
      }
      return;
    }

    if (screen === 'skill-catalog') {
      if (key.upArrow) {
        setSkillCatalogCursor(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setSkillCatalogCursor(current => Math.min(Math.max(skillCatalogEntries.length - 1, 0), current + 1));
      } else if ((input === ' ' || input === '\t') && activeSkillCatalogEntry) {
        setSelectedCatalogIds(current => {
          const next = new Set(current);
          if (next.has(activeSkillCatalogEntry.id)) {
            next.delete(activeSkillCatalogEntry.id);
          } else {
            next.add(activeSkillCatalogEntry.id);
          }
          return next;
        });
      } else if ((input === 'v' || input === 'V') && activeSkillCatalogEntry) {
        void openSkillPreview(previewCatalogSkill(activeSkillCatalogEntry), 'skill-catalog');
      } else if (key.return) {
        const entries =
          selectedCatalogEntries.length > 0
            ? selectedCatalogEntries
            : activeSkillCatalogEntry
              ? [activeSkillCatalogEntry]
              : [];

        if (entries.length === 0) {
          setInstallError('Select at least one skill before continuing.');
          return;
        }

        setPendingSkillInstalls(entries.map(buildCatalogInstallSpec));
        setScopeIndex(0);
        setInstallError(null);
        setNotice(null);
        setScreen('skill-scope');
      }
      return;
    }

    if (screen === 'skill-input') {
      if (key.return) {
        if (!skillInput.trim()) {
          setInstallError('Enter a skill identifier before continuing.');
          return;
        }

        try {
          const spec = buildGitHubInstallSpec(skillInput, activeSkillTarget.value);
          setPendingSkillInstalls([spec]);
          setInstallError(null);
          setNotice(null);
          void openSkillPreview(previewGitHubSkill(spec), 'skill-input');
        } catch (error) {
          setInstallError(error instanceof Error ? error.message : 'Unable to parse the skill reference.');
        }
        return;
      }

      if (key.backspace || key.delete) {
        setSkillInput(current => current.slice(0, -1));
        return;
      }

      if (isPrintableInput(input)) {
        setSkillInput(current => `${current}${input}`);
      }
      return;
    }

    if (screen === 'skill-target') {
      if (key.upArrow) {
        setSkillTargetIndex(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setSkillTargetIndex(current => Math.min(skillTargetOptions.length - 1, current + 1));
      } else if (key.return) {
        if (pendingSkillInstalls.length === 0) {
          setInstallError('Preview a GitHub skill before choosing the target provider.');
          return;
        }

        setPendingSkillInstalls(current => current.map(spec => ({ ...spec, target: activeSkillTarget.value })));
        setScopeIndex(0);
        setInstallError(null);
        setNotice(null);
        setScreen('skill-scope');
      }
      return;
    }

    if (screen === 'skill-scope') {
      if (key.upArrow) {
        setScopeIndex(current => Math.max(0, current - 1));
      } else if (key.downArrow) {
        setScopeIndex(current => Math.min(scopeOptions.length - 1, current + 1));
      } else if (key.return) {
        const scope = scopeOptions[scopeIndex]?.value ?? 'project';
        void installSkillBatch(scope, skillSource === 'github' ? activeSkillTarget.value : undefined);
      }
      return;
    }
  });

  const sidebar = useMemo(() => {
    const queueCount = selectedPrdPaths.length;
    const runCount = plans.length;
    const variantMode = activeSchedule.value === 'parallel' && selectedPrdPaths.length === 1;

    if (compact) {
      return (
        <Box width={sidebarWidth} flexDirection="column" marginRight={1} flexShrink={0}>
          <SectionPanel width={sidebarWidth}>
            <AsciiLogo />
            <Box marginTop={1} flexDirection="column">
              <HintLine>{`Context: ${contextLabel(initial.projectContextMode)}`}</HintLine>
              <HintLine>{`Provider: ${activeProvider.value}`}</HintLine>
              <HintLine>{`Skills: ${activeExecutionSkills.length}`}</HintLine>
              <HintLine>{`Schedule: ${activeSchedule.value}`}</HintLine>
              <HintLine>{`Queue: ${queueCount} PRDs`}</HintLine>
              {dependencyCount > 0 ? <HintLine>{`Dependencies: ${dependencyCount}`}</HintLine> : null}
              {variantMode ? <HintLine>{`Variants: ${runCount} runs`}</HintLine> : null}
              <HintLine>{`Budget: ${Math.max(...plans.map(plan => plan.iterations), 0)} PRD passes`}</HintLine>
            </Box>
          </SectionPanel>
        </Box>
      );
    }

    return (
      <Box width={sidebarWidth} flexDirection="column" marginRight={1} flexShrink={0}>
        <SectionPanel width={sidebarWidth}>
          <AsciiLogo />
        </SectionPanel>
        <Box marginTop={1}>
          <SectionPanel title="Loadout" subtitle="LIVE" width={sidebarWidth}>
            <LabelValue label="Context" value={contextLabel(initial.projectContextMode)} labelWidth={sidebarLabelWidth} valueWidth={sidebarValueWidth} />
            <LabelValue label="Provider" value={activeProvider.value} labelWidth={sidebarLabelWidth} valueWidth={sidebarValueWidth} />
            <LabelValue label="Skills" value={String(activeExecutionSkills.length)} labelWidth={sidebarLabelWidth} valueWidth={sidebarValueWidth} />
            <LabelValue label="PRDs" value={String(queueCount)} labelWidth={sidebarLabelWidth} valueWidth={sidebarValueWidth} />
            {variantMode ? (
              <LabelValue label="Variants" value={String(runCount)} labelWidth={sidebarLabelWidth} valueWidth={sidebarValueWidth} />
            ) : null}
            {dependencyCount > 0 ? (
              <LabelValue label="Dependencies" value={String(dependencyCount)} labelWidth={sidebarLabelWidth} valueWidth={sidebarValueWidth} />
            ) : null}
            <LabelValue label="Schedule" value={activeSchedule.value} labelWidth={sidebarLabelWidth} valueWidth={sidebarValueWidth} />
            <LabelValue
              label="Workspace"
              value={launchPlanWorkspaceStrategy}
              labelWidth={sidebarLabelWidth}
              valueWidth={sidebarValueWidth}
            />
            <LabelValue
              label="Max PRD passes"
              value={String(Math.max(...plans.map(plan => plan.iterations), 0))}
              labelWidth={sidebarLabelWidth}
              valueWidth={sidebarValueWidth}
            />
          </SectionPanel>
        </Box>
      </Box>
    );
  }, [
    activeProvider.value,
    activeSchedule.value,
    compact,
    activeExecutionSkills.length,
    initial.projectContextMode,
    initial.workspaceStrategy,
    plans,
    dependencyCount,
    launchPlanWorkspaceStrategy,
    selectedPrdPaths.length,
    sidebarLabelWidth,
    sidebarValueWidth,
    sidebarWidth
  ]);

  const prdWindow = sliceWindow(prdOptions, prdWindowStart, prdRows);
  const bootstrapWindow = sliceWindow(projectBootstrap.items, bootstrapWindowStart, bootstrapRows);
  const backlogWindow = sliceWindow(backlogRowsAll, backlogWindowStart, backlogRows);
  const dependencyWindow = sliceWindow(dependencyRowsAll, dependencyWindowStart, dependencyRowsVisible);
  const providerSkillWindow = sliceWindow(providerSkillRows, providerSkillWindowStart, providerSkillRowsVisible);
  const notificationChannelWindow = sliceWindow(notificationChannelRows, notificationChannelWindowStart, notificationRowsVisible);
  const directorySkillWindow = sliceWindow(directorySkills, directorySkillWindowStart, directoryRows);
  const skillCatalogWindow = sliceWindow(skillCatalogEntries, skillCatalogWindowStart, skillCatalogRows);
  const backlogPolicyWindow = sliceWindow(backlogPolicyRows, backlogPolicyWindowStart, backlogPolicyRowsVisible);
  const iterationWindow = sliceWindow(iterationEntries, iterationWindowStart, iterationRows);
  const viewerWindow = viewer
    ? sliceWindow(viewer.lines, viewer.scroll, viewerRows)
    : {
        start: 0,
        values: [] as string[]
      };
  const prdItemsBelow = Math.max(0, prdOptions.length - (prdWindow.start + prdWindow.values.length));
  const bootstrapItemsBelow = Math.max(0, projectBootstrap.items.length - (bootstrapWindow.start + bootstrapWindow.values.length));
  const backlogItemsBelow = Math.max(0, backlogRowsAll.length - (backlogWindow.start + backlogWindow.values.length));
  const dependencyItemsBelow = Math.max(0, dependencyRowsAll.length - (dependencyWindow.start + dependencyWindow.values.length));
  const providerSkillItemsBelow = Math.max(0, providerSkillRows.length - (providerSkillWindow.start + providerSkillWindow.values.length));
  const notificationChannelRowsBelow = Math.max(0, notificationChannelRows.length - (notificationChannelWindow.start + notificationChannelWindow.values.length));
  const directorySkillsBelow = Math.max(0, directorySkills.length - (directorySkillWindow.start + directorySkillWindow.values.length));
  const skillCatalogItemsBelow = Math.max(0, skillCatalogEntries.length - (skillCatalogWindow.start + skillCatalogWindow.values.length));
  const backlogPolicyBelow = Math.max(0, backlogPolicyRows.length - (backlogPolicyWindow.start + backlogPolicyWindow.values.length));
  const iterationItemsBelow = Math.max(0, iterationEntries.length - (iterationWindow.start + iterationWindow.values.length));
  const viewerLinesBelow = viewer ? Math.max(0, viewer.lines.length - (viewerWindow.start + viewerWindow.values.length)) : 0;
  const activeBacklogRow = backlogRowsAll[backlogCursor] ?? null;
  const activeDependencyRow = dependencyRowsAll[dependencyCursor] ?? null;
  const activeBacklogItem =
    activeBacklogRow?.kind === 'item' && activeBacklogRow.itemId
      ? backlogByPrd[activeBacklogRow.prdPath]?.items.find(item => item.id === activeBacklogRow.itemId) ?? null
      : null;
  const tabs = useMemo(() => {
    if (screen === 'resume-run') {
      return ['RESUME', 'MODE', 'ARCADE'];
    }

    if (screen === 'about') {
      return ['MODE', 'ABOUT', 'ARCADE'];
    }

    if (
      screen === 'skills-menu' ||
      screen === 'skill-catalog' ||
      screen === 'skill-view' ||
      screen === 'skill-input' ||
      screen === 'skill-target' ||
      screen === 'skill-scope' ||
      screen === 'skill-progress'
    ) {
      return ['MODE', 'SKILLS', 'ARCADE'];
    }

    if (screen === 'bootstrap' || screen === 'bootstrap-view') {
      return ['BOOTSTRAP', 'MODE', 'ARCADE'];
    }

    return ['MODE', 'PROVIDER', activeHome.value === 'create-prd' ? 'CREATE' : 'PRDS', 'BACKLOG', 'RUNTIME', 'SCHEDULE', 'ITERATIONS', 'LAUNCH', 'ARCADE'];
  }, [activeHome.value, screen]);

  const activeTabIndex = (() => {
    if (arcadeOpen) return Math.max(tabs.length - 1, 0);
    if (screen === 'resume-run') return 0;
    if (screen === 'bootstrap' || screen === 'bootstrap-view') return 0;
    if (screen === 'home' || screen === 'notifications' || screen === 'notification-events' || screen === 'notification-channels' || screen === 'notification-edit' || screen === 'cleanup-confirm') return 0;
    if (screen === 'about') return 0;
    if (screen === 'provider' || screen === 'provider-skills' || screen === 'provider-skill-action') return 1;
    if (
      screen === 'prds' ||
      screen === 'brief' ||
      screen === 'brief-created' ||
      (screen === 'skill-mode' && skillPicker?.context === 'create' && skillPicker.purpose === 'prd') ||
      (screen === 'skill-directory' && skillPicker?.context === 'create' && skillPicker.purpose === 'prd')
    ) {
      return 2;
    }
    if (
      screen === 'backlog' ||
      screen === 'dependencies' ||
      screen === 'backlog-edit' ||
      screen === 'backlog-view' ||
      screen === 'prd-view' ||
      screen === 'prd-edit' ||
      screen === 'backlog-policy' ||
      (screen === 'skill-mode' && skillPicker?.purpose === 'backlog') ||
      (screen === 'skill-directory' && skillPicker?.purpose === 'backlog')
    ) {
      return 3;
    }
    if (screen === 'environment') return 4;
    if (screen === 'schedule') return 5;
    if (screen === 'iterations') return 6;
    if (screen === 'token-budget') return 7;
    if (screen === 'review') return 7;
    return 1;
  })();

  const installedSkillRows = compact ? 3 : 5;
  const builtinSkillRows = installedSkills.builtin.slice(0, installedSkillRows);
  const projectSkillRows = installedSkills.project.slice(0, installedSkillRows);
  const globalSkillRows = installedSkills.global.slice(0, installedSkillRows);
  const showBusyPanel = Boolean(busyMessage) && screen !== 'skill-progress';
  const busyCopy = busyMessage ? busyStateCopy(busyMessage) : null;

  return (
    <ThemeProvider theme={systemTheme}>
      <WindowFrame
        footerLeft={busyMessage ?? `${contextLabel(initial.projectContextMode)} · Mode ${activeHome.label}`}
        footerRight={arcadeOpen ? 'Arcade active' : busyMessage ? 'Working' : 'Wizard online'}
      >
        <SystemTabs tabs={tabs} activeIndex={activeTabIndex} />
        <Box>
          {showSidebar ? sidebar : null}
          <Box flexGrow={1} flexDirection="column">
            {arcadeOpen ? (
              <ArcadeCabinet
                maxWidth={columns - (showSidebar ? sidebarWidth + 8 : 6)}
                maxHeight={rows - 10}
                onClose={() => setArcadeOpen(false)}
              />
            ) : showBusyPanel ? (
              <SectionPanel title={backlogBatchProgress ? backlogBatchTitle(backlogBatchProgress) : busyCopy?.title ?? 'Working'} subtitle="RUNNING" flexGrow={1}>
                <Box flexDirection="column" justifyContent="center" flexGrow={1}>
                  <Spinner label={busyMessage ?? 'Working'} />
                  {backlogBatchProgress ? (
                    <Box marginTop={1} flexDirection="column">
                      <ProgressBar value={backlogBatchProgressValue(backlogBatchProgress)} />
                      <Box marginTop={1} flexDirection="column">
                        <Text color={palette.accent}>{`PRD ${backlogBatchProgress.currentIndex}/${backlogBatchProgress.total} · ${path.basename(backlogBatchProgress.currentPrdPath)}`}</Text>
                        <Text color={palette.dim}>{backlogBatchDetail(backlogBatchProgress)}</Text>
                        {backlogBatchProgress.history.map(entry => (
                          <Text key={entry} color={palette.dim}>
                            {entry}
                          </Text>
                        ))}
                      </Box>
                    </Box>
                  ) : null}
                  <Box marginTop={1} flexDirection="column">
                    <Text color={palette.dim}>{busyCopy?.detail ?? 'Ralphi is processing the current step.'}</Text>
                    <HintLine>Wait for this step to finish before continuing.</HintLine>
                    <HintLine>Press G to open the ARCADE menu while Ralphi works.</HintLine>
                  </Box>
                </Box>
              </SectionPanel>
            ) : (
              <>
                {!showSidebar ? (
                  <Box marginBottom={1}>
                    <HintLine>
                      {`${contextLabel(initial.projectContextMode)} · Provider ${activeProvider.value} · Schedule ${activeSchedule.value} · Queue ${selectedPrdPaths.length} PRDs`}
                    </HintLine>
                  </Box>
                ) : null}

            {screen === 'resume-run' && pendingRun && (
              <SectionPanel title="Unfinished execution found" subtitle="RESUME" flexGrow={1}>
                <Text color={palette.dim}>
                  Ralphi found a saved execution that did not reach a final summary. Choose whether to continue from the last checkpoint, restart the same run, or discard the saved state.
                </Text>
                <Box marginTop={1} flexDirection="column">
                  <LabelValue label="Provider" value={pendingRun.session.config.tool} />
                  <LabelValue label="Schedule" value={pickScheduleLabel(pendingRun.session.config.schedule)} />
                  <LabelValue label="Workspace" value={pendingRun.session.config.workspaceStrategy} />
                  <LabelValue label="Resume" value={resumeClassificationLabel(pendingRun.driftReport)} />
                  <LabelValue label="Updated" value={new Date(pendingRun.session.updatedAt).toLocaleString()} />
                  <LabelValue label="PRDs" value={String(pendingRun.session.config.plans.length)} />
                </Box>
                {pendingRun.driftReport.issues.length > 0 ? (
                  <Box marginTop={1} flexDirection="column">
                    <Text color={pendingRun.driftReport.classification === 'must_restart' ? palette.danger : palette.accent}>
                      Drift check
                    </Text>
                    {pendingRun.driftReport.issues.map(issue => (
                      <Text key={issue.id} color={issue.severity === 'blocking' ? palette.danger : palette.text}>
                        {`• ${issue.label} · ${issue.detail}`}
                      </Text>
                    ))}
                  </Box>
                ) : null}
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>Saved progress</Text>
                  {pendingRunSummaryRows(pendingRun).map(row => (
                    <Text key={row} color={palette.text}>
                      {`• ${row}`}
                    </Text>
                  ))}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  {pendingRunOptions.map((option, index) => (
                    <ChoiceRow compact key={option.value} active={index === pendingRunIndex} label={option.label} description={option.description} />
                  ))}
                </Box>
                <HintLine>Use ↑ ↓ and Enter. q cancels the wizard.</HintLine>
              </SectionPanel>
            )}

            {screen === 'home' && (
              <SectionPanel title="Select a launch mode" subtitle="ENTRY" flexGrow={1}>
                {homeOptions.map((option, index) => (
                  <ChoiceRow compact key={option.value} active={index === homeIndex} label={option.label} description={option.description} />
                ))}
                <HintLine>Use ↑ ↓ and Enter. q cancels.</HintLine>
              </SectionPanel>
            )}

            {screen === 'notifications' && (
              <SectionPanel title="Project notifications" subtitle="WEBHOOKS" flexGrow={1}>
                <Text color={palette.dim}>
                  Keep process events and webhook destinations separate. Settings are saved into .ralphi.json.
                </Text>
                <Box marginTop={1} flexDirection="column">
                  {notificationMenuOptions.map((option, index) => (
                    <ChoiceRow compact
                      key={option.value}
                      active={index === notificationMenuCursor}
                      label={option.label}
                      description={option.description}
                    />
                  ))}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <LabelValue
                    label="Events on"
                    value={`${notificationEventRows.filter(row => row.checked).length}/${notificationEventRows.length}`}
                  />
                  <LabelValue
                    label="Destinations"
                    value={`${notificationChannelRows.filter(row => row.configured).length} configured · ${notificationChannelRows.filter(row => row.checked).length} enabled`}
                  />
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>{activeNotificationMenu.label}</Text>
                  <Text color={palette.dim}>{truncateEnd(activeNotificationMenu.description, 94)}</Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Enter opens the selected section. Left arrow returns to the launch menu.</HintLine>
                  <HintLine>Destinations without a webhook URL will prompt for one before they can be enabled.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'notification-events' && (
              <SectionPanel title="Notification events" subtitle="PROCESS" flexGrow={1}>
                <Text color={palette.dim}>Choose which lifecycle events should emit notifications.</Text>
                <Box marginTop={1} flexDirection="column">
                  {notificationEventRows.map((row, index) => (
                    <SelectRow
                      key={row.id}
                      active={index === notificationEventCursor}
                      checked={row.checked}
                      label={row.label}
                      detail={truncateEnd(row.detail, 92)}
                    />
                  ))}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>{activeNotificationEventRow?.label ?? 'No event selected'}</Text>
                  <Text color={palette.dim}>{truncateEnd(activeNotificationEventRow?.detail ?? ' ', 94)}</Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Enter or Space toggles the selected event.</HintLine>
                  <HintLine>Left arrow returns to the notifications menu.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'notification-channels' && (
              <SectionPanel title="Notification destinations" subtitle="WEBHOOKS" flexGrow={1}>
                <Text color={palette.dim}>
                  Configure webhook destinations. Enter edits the selected destination. Space enables or disables a configured destination.
                </Text>
                <HintLine>{notificationChannelWindow.start > 0 ? `↑ ${notificationChannelWindow.start} more above` : ' '}</HintLine>
                {notificationChannelWindow.values.map((row, index) => {
                  const absoluteIndex = notificationChannelWindow.start + index;
                  return (
                    <SelectRow
                      key={row.id}
                      active={absoluteIndex === notificationChannelCursor}
                      checked={row.checked}
                      label={row.label}
                      detail={truncateEnd(row.detail, 92)}
                    />
                  );
                })}
                <HintLine>{notificationChannelRowsBelow > 0 ? `↓ ${notificationChannelRowsBelow} more below` : ' '}</HintLine>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>{activeNotificationChannelRow?.label ?? 'No destination selected'}</Text>
                  <Text color={palette.dim}>{truncateEnd(activeNotificationChannelRow?.detail ?? ' ', 94)}</Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>
                    {activeNotificationChannelRow && !activeNotificationChannelRow.configured
                      ? 'Press Enter to add the webhook URL for the selected destination.'
                      : 'Press Enter to edit the webhook URL for the selected destination.'}
                  </HintLine>
                  <HintLine>Left arrow returns to the notifications menu.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'notification-edit' && (
              <SectionPanel title="Edit notification channel" subtitle="WEBHOOK URL" flexGrow={1}>
                <Text color={palette.dim}>
                  Paste the full webhook URL for this channel. Leave it blank and press Enter to clear the channel.
                </Text>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>{notificationEditChannel ? notificationChannelLabel(notificationEditChannel) : 'Channel'}</Text>
                  <Box borderStyle="round" borderColor={palette.border} paddingX={1}>
                    <Text color={palette.text}>{notificationUrlInput || ' '}</Text>
                  </Box>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>{notificationEditChannel ? notificationChannelUrlHint(notificationEditChannel) : 'Expected URL: paste the webhook endpoint.'}</HintLine>
                  <HintLine>Project config: .ralphi.json</HintLine>
                  <HintLine>Enter saves and returns to destinations. Left arrow returns without saving.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'cleanup-confirm' && (
              <SectionPanel title="Cleanup Ralphi artifacts" subtitle="DANGER" flexGrow={1}>
                <Text color={palette.dim}>
                  Remove every execution worktree and branch that Ralphi created for this repository, even when the branch is dirty or incomplete.
                </Text>
                <Box marginTop={1} flexDirection="column">
                  <LabelValue label="Worktrees" value={`${cleanupPreview?.actionable.length ?? 0} to remove`} />
                  <LabelValue label="Branches" value={`${cleanupPreview?.actionableBranches.length ?? 0} to remove`} />
                </Box>
                <Box marginTop={1} flexDirection="column">
                  {cleanupPreview && cleanupPreview.actionable.length === 0 && cleanupPreview.actionableBranches.length === 0 ? (
                    <Text color={palette.dim}>No Ralphi-managed execution branches or worktrees were found.</Text>
                  ) : null}
                  {(cleanupPreview?.actionable ?? []).slice(0, 3).map(entry => (
                    <Text key={`cleanup-worktree-${entry.path}`} color={palette.text}>
                      {`• worktree · ${displayPath(entry.path, rootDir)}`}
                    </Text>
                  ))}
                  {(cleanupPreview?.actionableBranches ?? []).slice(0, 3).map(entry => (
                    <Text key={`cleanup-branch-${entry.name}`} color={palette.text}>
                      {`• branch · ${entry.name}`}
                    </Text>
                  ))}
                  {cleanupPreview && cleanupPreview.actionable.length + cleanupPreview.actionableBranches.length > 6 ? (
                    <HintLine>
                      {`... and ${cleanupPreview.actionable.length + cleanupPreview.actionableBranches.length - 6} more managed artifacts`}
                    </HintLine>
                  ) : null}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>Confirmation</Text>
                  <Box borderStyle="round" borderColor={palette.border} paddingX={1}>
                    <Text color={palette.text}>{cleanupInput || ' '}</Text>
                  </Box>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Type CLEANUP and press Enter to remove the managed worktrees and branches.</HintLine>
                  <HintLine>Left arrow returns without changing anything.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'about' && (
              <SectionPanel title="About Ralphi" subtitle="CONTROL DECK" flexGrow={1}>
                <Text color={palette.text}>
                  Ralphi turns PRDs into tracked execution lanes, keeps provider runs resumable, and gives you a live terminal dashboard for launch, review, and recovery.
                </Text>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>What it is built for</Text>
                  {aboutHighlights.map(line => (
                    <Text key={line} color={palette.text}>
                      {`• ${line}`}
                    </Text>
                  ))}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>How the runtime stays operational</Text>
                  {aboutRuntimeLines.map(line => (
                    <Text key={line} color={palette.text}>
                      {`• ${line}`}
                    </Text>
                  ))}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>Project surfaces</Text>
                  <LabelValue label="State" value="./.ralphi/state/<slug>" />
                  <LabelValue label="Archive" value="./.ralphi/archive" />
                  <LabelValue label="Backlog" value="backlog.json" />
                  <LabelValue label="Built-ins" value="./ralph/skills" />
                  <LabelValue label="Defaults" value="./.ralphi.json" />
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Use Left arrow to return to the launch menu.</HintLine>
                  <HintLine>Launch mode, skills, provider choice, and backlog review stay in the same control loop.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'bootstrap' && (
              <SectionPanel
                title={hasOptionalBootstrapOnly ? 'Optional bootstrap' : 'Project bootstrap'}
                subtitle={`${projectBootstrap.items.filter(item => item.selected).length}/${projectBootstrap.items.length} selected`}
                flexGrow={1}
              >
                <Text color={palette.dim}>
                  {hasOptionalBootstrapOnly
                    ? 'Ralphi already found the main project conventions it needs. The items below are optional extras you can scaffold when they become useful.'
                    : 'Ralphi found a few missing project conventions. Review them before the first run so provider memory, local settings, and optional devcontainer support start in a clean state.'}
                </Text>
                <HintLine>{bootstrapWindow.start > 0 ? `↑ ${bootstrapWindow.start} more above` : ' '}</HintLine>
                {bootstrapWindow.values.map((item, index) => {
                  const absoluteIndex = bootstrapWindow.start + index;
                  return (
                    <SelectRow
                      key={item.id}
                      active={absoluteIndex === bootstrapCursor}
                      checked={item.selected}
                      label={item.label}
                      detail={item.recommended ? 'recommended' : 'optional'}
                    />
                  );
                })}
                <HintLine>{bootstrapItemsBelow > 0 ? `↓ ${bootstrapItemsBelow} more below` : ' '}</HintLine>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>{activeBootstrapItem?.label ?? 'No item selected'}</Text>
                  <Text color={palette.dim}>{truncateEnd(activeBootstrapItem?.description ?? ' ', 94)}</Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Space toggles an item. `V` previews the scaffold. Enter applies the selection.</HintLine>
                  <HintLine>{hasOptionalBootstrapOnly ? '`S` closes this optional setup for now.' : '`S` skips this step for now.'}</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'prds' && (
              <SectionPanel title="Select PRDs" subtitle={`${selectedExistingPrds.size} queued · newest first`} flexGrow={1}>
                <Text color={palette.dim}>{`Provider locked in for this launch: ${activeProvider.value}.`}</Text>
                <HintLine>{prdWindow.start > 0 ? `↑ ${prdWindow.start} more above` : ' '}</HintLine>
                {prdWindow.values.map((prdPath, index) => {
                  const absoluteIndex = prdWindow.start + index;
                  return (
                    <SelectRow
                      key={prdPath}
                      active={absoluteIndex === prdCursor}
                      checked={selectedExistingPrds.has(prdPath)}
                      label={path.basename(prdPath)}
                    />
                  );
                })}
                <HintLine>{prdItemsBelow > 0 ? `↓ ${prdItemsBelow} more below` : ' '}</HintLine>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Space toggles a PRD. Enter chooses the backlog skill and prepares all selected backlogs.</HintLine>
                  <HintLine>Left arrow returns to provider skills.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'brief' && (
              <SectionPanel title="Create a new PRD" subtitle={draftForm.fullscreen ? 'FULL SCREEN' : 'FORM'} flexGrow={1}>
                <Text color={palette.dim}>
                  {`Provider ${activeProvider.value} is already selected for this launch. Fill in the title and a longer description, then choose the PRD skill and backlog skill.`}
                </Text>
                <Box marginTop={1} flexDirection="column">
                  <Text color={draftForm.field === 'title' ? palette.accent : palette.dim}>Title</Text>
                  <Box borderStyle="round" borderColor={draftForm.field === 'title' ? palette.border : palette.borderSoft} paddingX={1}>
                    <Text color={palette.text}>{draftForm.title || ' '}</Text>
                  </Box>
                </Box>
                <Box marginTop={1} flexDirection="column" flexGrow={1}>
                  <Text color={draftForm.field === 'description' ? palette.accent : palette.dim}>Description</Text>
                  <Box
                    borderStyle="round"
                    borderColor={draftForm.field === 'description' ? palette.border : palette.borderSoft}
                    paddingX={1}
                    flexDirection="column"
                    flexGrow={1}
                  >
                    {textareaWindow(
                      draftForm.description || ' ',
                      draftForm.fullscreen ? Math.max(10, rows - 24) : Math.max(5, Math.min(8, rows - 24))
                    ).values.map((line, index) => (
                      <Text key={`draft-description-${index}`} color={palette.text}>
                        {line || ' '}
                      </Text>
                    ))}
                  </Box>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Tab switches fields. Enter continues. Shift+Enter adds a new line in Description.</HintLine>
                  <HintLine>`Ctrl+F` toggles full screen for longer edits.</HintLine>
                  <HintLine>Character shortcuts stay local to the editor while you type.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'skill-mode' && skillPicker && (
              <SectionPanel
                title={skillPicker.purpose === 'prd' ? 'Select PRD skill' : 'Select backlog skill'}
                subtitle={skillPicker.context === 'create' ? 'SKILL STEP' : 'BACKLOG SETUP'}
                flexGrow={1}
              >
                <Text color={palette.dim}>
                  {skillPicker.purpose === 'prd'
                    ? 'Choose Ralphi’s built-in PRD skill or browse project/global provider directories.'
                    : 'Choose Ralphi’s built-in backlog skill or browse project/global provider directories.'}
                </Text>
                <Box marginTop={1} flexDirection="column">
                  {skillModeOptions.map((option, index) => {
                    const builtinSkill = skillPicker.purpose === 'backlog' ? builtinBacklogSkill : builtinPrdSkill;
                    const description =
                      option.value === 'builtin'
                        ? `${builtinSkill.name} · ${truncateEnd(builtinSkill.description, 72)}`
                        : directorySkills.length === 0
                          ? 'No provider skill directory was found in this project or in your home folder.'
                          : `Browse ${directorySkills.length} provider skill${directorySkills.length === 1 ? '' : 's'} from project/global directories.`;

                    return <ChoiceRow compact key={option.value} active={index === skillModeIndex} label={option.label} description={description} />;
                  })}
                </Box>
                <HintLine>Use ↑ ↓ and Enter. Left arrow returns to the previous step.</HintLine>
              </SectionPanel>
            )}

            {screen === 'skill-directory' && skillPicker && (
              <SectionPanel
                title={skillPicker.purpose === 'prd' ? 'Choose PRD skill from directories' : 'Choose backlog skill from directories'}
                subtitle="PROVIDER SKILLS"
                flexGrow={1}
              >
                <HintLine>{directorySkillWindow.start > 0 ? `↑ ${directorySkillWindow.start} more above` : ' '}</HintLine>
                {directorySkillWindow.values.map((skill, index) => {
                  const absoluteIndex = directorySkillWindow.start + index;
                  return (
                    <ChoiceRow compact
                      key={skill.id}
                      active={absoluteIndex === directorySkillCursor}
                      label={skill.name}
                      description={skillDetail(skill)}
                    />
                  );
                })}
                <HintLine>{directorySkillsBelow > 0 ? `↓ ${directorySkillsBelow} more below` : ' '}</HintLine>
                <HintLine>Use ↑ ↓ and Enter. Left arrow returns to the built-in vs directory choice.</HintLine>
              </SectionPanel>
            )}

            {screen === 'backlog-policy' && (
              <SectionPanel title="Existing backlog policy" subtitle={`${backlogPolicyRows.length} PRDs`} flexGrow={1}>
                <Text color={palette.dim}>
                  Existing backlog files were found. Choose whether to reuse each one or regenerate it with the selected backlog skill.
                </Text>
                <HintLine>{backlogPolicyWindow.start > 0 ? `↑ ${backlogPolicyWindow.start} more above` : ' '}</HintLine>
                {backlogPolicyWindow.values.map((row, index) => {
                  const absoluteIndex = backlogPolicyWindow.start + index;
                  return (
                    <SelectRow
                      key={row.prdPath}
                      active={absoluteIndex === backlogPolicyCursor}
                      label={path.basename(row.prdPath)}
                      detail={row.hasExisting ? row.mode : 'generate'}
                    />
                  );
                })}
                <HintLine>{backlogPolicyBelow > 0 ? `↓ ${backlogPolicyBelow} more below` : ' '}</HintLine>
                <HintLine>Space toggles reuse/regenerate for PRDs that already have a backlog. Enter executes the chosen plan.</HintLine>
              </SectionPanel>
            )}

            {screen === 'brief-created' && (
              <SectionPanel title="PRD drafts ready" subtitle={`${createdDrafts.length} CREATED`} flexGrow={1}>
                <Box flexDirection="column">
                  {createdDrafts.map(draft => (
                    <Text key={draft.path} color={palette.text}>
                      {`• ${path.basename(draft.path)} · PRD ${draft.prdSkillName} · Backlog ${draft.backlogSkillName}`}
                    </Text>
                  ))}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  {briefCreatedOptions.map((option, index) => (
                    <ChoiceRow compact key={option.value} active={index === briefCreatedIndex} label={option.label} description={option.description} />
                  ))}
                </Box>
                <HintLine>Enter confirms. Left arrow returns to the brief editor.</HintLine>
              </SectionPanel>
            )}

            {screen === 'backlog' && (
              <SectionPanel title="Review and edit backlog" subtitle={`${selectedPrdPaths.length} PRDs`} flexGrow={1}>
                <HintLine>{backlogWindow.start > 0 ? `↑ ${backlogWindow.start} more above` : ' '}</HintLine>
                {backlogWindow.values.map((row, index) => {
                  const absoluteIndex = backlogWindow.start + index;
                  return (
                    <SelectRow
                      key={`${row.prdPath}:${row.itemId ?? 'root'}:${row.kind}`}
                      active={absoluteIndex === backlogCursor}
                      label={row.label}
                      detail={truncateEnd(row.detail, 18)}
                    />
                  );
                })}
                <HintLine>{backlogItemsBelow > 0 ? `↓ ${backlogItemsBelow} more below` : ' '}</HintLine>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>
                    {activeBacklogRow?.kind === 'action'
                      ? 'Regenerate backlog'
                      : activeBacklogRow?.kind === 'prd'
                        ? path.basename(activeBacklogRow.prdPath)
                        : `${path.basename(activeBacklogRow?.prdPath ?? '')} · ${statusLabel(activeBacklogRow?.status ?? 'pending')}`}
                  </Text>
                  <Text color={palette.dim}>{truncateEnd(activeBacklogItem?.description || activeBacklogRow?.description || 'No item selected.', 72)}</Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>`A` add item · `E` edit item · `C` toggle done</HintLine>
                  <HintLine>`D` disable · `X` remove · `P` view PRD · `R` edit PRD · `V` view item · Enter continues / regenerates</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'dependencies' && (
              <SectionPanel title="Link PRD dependencies" subtitle="SEQUENCE" flexGrow={1}>
                <Text color={palette.dim}>Choose which selected PRD must finish before another one can start. PRDs without a dependency can start immediately.</Text>
                <HintLine>{dependencyWindow.start > 0 ? `↑ ${dependencyWindow.start} more above` : ' '}</HintLine>
                {dependencyWindow.values.map((row, index) => {
                  const absoluteIndex = dependencyWindow.start + index;
                  return (
                    <SelectRow
                      key={row.prdPath}
                      active={absoluteIndex === dependencyCursor}
                      label={row.label}
                      detail={truncateEnd(row.detail, 22)}
                    />
                  );
                })}
                <HintLine>{dependencyItemsBelow > 0 ? `↓ ${dependencyItemsBelow} more below` : ' '}</HintLine>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>{activeDependencyRow?.label ?? 'No PRD selected'}</Text>
                  <Text color={palette.dim}>{truncateEnd(activeDependencyRow?.description ?? 'Pick a PRD to set when it may start.', 92)}</Text>
                  {dependencyOrderLabel ? <HintLine>{`Start order preview: ${truncateEnd(dependencyOrderLabel, 92)}`}</HintLine> : null}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Space or right arrow picks the next dependency. Backspace clears the dependency.</HintLine>
                  <HintLine>Enter continues to environment setup. Left arrow returns to backlog review.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'backlog-edit' && backlogEditor && (
              <SectionPanel
                title={backlogEditor.mode === 'add' ? 'Add backlog item' : 'Edit backlog item'}
                subtitle={backlogEditor.fullscreen ? 'FULL SCREEN' : 'BACKLOG'}
                flexGrow={1}
              >
                <Text color={palette.dim}>{`Target PRD: ${path.basename(backlogEditor.prdPath)}`}</Text>
                <Box marginTop={1} flexDirection="column">
                  <Text color={backlogEditor.field === 'title' ? palette.accent : palette.dim}>Title</Text>
                  <Box borderStyle="round" borderColor={backlogEditor.field === 'title' ? palette.border : palette.borderSoft} paddingX={1}>
                    <Text color={palette.text}>{backlogEditor.title || ' '}</Text>
                  </Box>
                </Box>
                <Box marginTop={1} flexDirection="column" flexGrow={1}>
                  <Text color={backlogEditor.field === 'description' ? palette.accent : palette.dim}>Description</Text>
                  <Box
                    borderStyle="round"
                    borderColor={backlogEditor.field === 'description' ? palette.border : palette.borderSoft}
                    paddingX={1}
                    flexDirection="column"
                    flexGrow={1}
                  >
                    {textareaWindow(
                      backlogEditor.description || ' ',
                      backlogEditor.fullscreen ? Math.max(10, rows - 24) : Math.max(5, Math.min(8, rows - 24))
                    ).values.map((line, index) => (
                      <Text key={`backlog-editor-line-${index}`} color={palette.text}>
                        {line || ' '}
                      </Text>
                    ))}
                  </Box>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Tab switches fields. Enter saves. Shift+Enter inserts a new line in Description.</HintLine>
                  <HintLine>`Ctrl+F` toggles full screen. Left arrow returns without saving.</HintLine>
                  <HintLine>Character shortcuts stay local to the editor while you type.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'backlog-view' && viewer && (
              <SectionPanel title={viewer.title} subtitle={viewer.subtitle} flexGrow={1}>
                <HintLine>{viewerWindow.start > 0 ? `↑ ${viewerWindow.start} more above` : ' '}</HintLine>
                {viewerWindow.values.map((line, index) => (
                  <Text key={`backlog-view-${index}`} color={palette.text}>
                    {line || ' '}
                  </Text>
                ))}
                <HintLine>{viewerLinesBelow > 0 ? `↓ ${viewerLinesBelow} more below` : ' '}</HintLine>
                <HintLine>Use ↑ ↓ to scroll. Enter or Left arrow returns.</HintLine>
              </SectionPanel>
            )}

            {screen === 'prd-view' && viewer && (
              <SectionPanel title={viewer.title} subtitle={viewer.subtitle} flexGrow={1}>
                <HintLine>{viewerWindow.start > 0 ? `↑ ${viewerWindow.start} more above` : ' '}</HintLine>
                {viewerWindow.values.map((line, index) => (
                  <Text key={`prd-view-${index}`} color={palette.text}>
                    {line || ' '}
                  </Text>
                ))}
                <HintLine>{viewerLinesBelow > 0 ? `↓ ${viewerLinesBelow} more below` : ' '}</HintLine>
                <HintLine>Use ↑ ↓ to scroll. Enter or Left arrow returns.</HintLine>
              </SectionPanel>
            )}

            {screen === 'bootstrap-view' && viewer && (
              <SectionPanel title={viewer.title} subtitle={viewer.subtitle} flexGrow={1}>
                <HintLine>{viewerWindow.start > 0 ? `↑ ${viewerWindow.start} more above` : ' '}</HintLine>
                {viewerWindow.values.map((line, index) => (
                  <Text key={`bootstrap-view-${index}`} color={palette.text}>
                    {line || ' '}
                  </Text>
                ))}
                <HintLine>{viewerLinesBelow > 0 ? `↓ ${viewerLinesBelow} more below` : ' '}</HintLine>
                <HintLine>Use ↑ ↓ to scroll. Enter or Left arrow returns.</HintLine>
              </SectionPanel>
            )}

            {screen === 'prd-edit' && prdEditor && (
              <SectionPanel title="Edit PRD" subtitle={prdEditor.fullscreen ? 'FULL SCREEN' : 'PRD'} flexGrow={1}>
                <Text color={palette.dim}>{`Target file: ${path.basename(prdEditor.prdPath)}`}</Text>
                <Box marginTop={1} flexDirection="column">
                  <Text color={prdEditor.field === 'title' ? palette.accent : palette.dim}>Title</Text>
                  <Box borderStyle="round" borderColor={prdEditor.field === 'title' ? palette.border : palette.borderSoft} paddingX={1}>
                    <Text color={palette.text}>{prdEditor.title || ' '}</Text>
                  </Box>
                </Box>
                <Box marginTop={1} flexDirection="column" flexGrow={1}>
                  <Text color={prdEditor.field === 'description' ? palette.accent : palette.dim}>Description</Text>
                  <Box
                    borderStyle="round"
                    borderColor={prdEditor.field === 'description' ? palette.border : palette.borderSoft}
                    paddingX={1}
                    flexDirection="column"
                    flexGrow={1}
                  >
                    {textareaWindow(
                      prdEditor.description || ' ',
                      prdEditor.fullscreen ? Math.max(10, rows - 24) : Math.max(5, Math.min(8, rows - 24))
                    ).values.map((line, index) => (
                      <Text key={`prd-editor-line-${index}`} color={palette.text}>
                        {line || ' '}
                      </Text>
                    ))}
                  </Box>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Tab switches fields. Enter saves. Shift+Enter inserts a new line in Description.</HintLine>
                  <HintLine>`Ctrl+F` toggles full screen. Saving also refreshes this PRD backlog.</HintLine>
                  <HintLine>Character shortcuts stay local to the editor while you type.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'provider' && (
              <SectionPanel title="Select provider" subtitle="CONFIG" flexGrow={1}>
                <Text color={palette.dim}>Choose the provider for this launch.</Text>
                <Box marginTop={1} flexDirection="column">
                  {providerOptions.map((option, index) => (
                    <Box key={option.value} flexShrink={1}>
                      <Text color={index === providerIndex ? palette.accent : palette.dim}>{index === providerIndex ? '> ' : '  '}</Text>
                      <Box flexGrow={1} flexShrink={1}>
                        <Text color={index === providerIndex ? palette.text : palette.dim} wrap="truncate-end">
                          {option.value}
                        </Text>
                      </Box>
                    </Box>
                  ))}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>{activeProvider.value}</Text>
                  {activeProviderStructureLines.map(line => (
                    <Text key={`${activeProvider.value}:${line}`} color={palette.text}>
                      {`• ${line}`}
                    </Text>
                  ))}
                </Box>
                <HintLine>Use ↑ ↓ and Enter. Left arrow returns to the launch menu.</HintLine>
                <HintLine>
                  {activeProviderHasNativeSkills
                    ? 'Enter continues to native execution skill selection.'
                    : 'Enter skips native execution skills because this provider uses its own project structure.'}
                </HintLine>
              </SectionPanel>
            )}

            {screen === 'provider-skills' && (
              <SectionPanel title="Select execution skills" subtitle={`${activeExecutionSkills.length} selected`} flexGrow={1}>
                <Text color={palette.dim}>
                  Defaults from .ralphi.json start checked. Select any additional provider-native skill for this run, or make it a project default.
                </Text>
                <HintLine>{providerSkillWindow.start > 0 ? `↑ ${providerSkillWindow.start} more above` : ' '}</HintLine>
                {providerSkillWindow.values.map((row, index) => {
                  if (row.kind === 'section') {
                    return (
                      <Box key={row.id} marginTop={index === 0 ? 0 : 1} flexDirection="column">
                        <Text color={palette.accent}>{row.label}</Text>
                        <Text color={palette.dim}>{truncateEnd(row.detail, 92)}</Text>
                      </Box>
                    );
                  }

                  const absoluteIndex = providerSkillWindow.start + index;
                  return (
                    <SelectRow
                      key={row.id}
                      active={absoluteIndex === providerSkillCursor}
                      checked={row.checked}
                      label={row.label}
                      detail={row.detail}
                    />
                  );
                })}
                <HintLine>{providerSkillItemsBelow > 0 ? `↓ ${providerSkillItemsBelow} more below` : ' '}</HintLine>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>{activeProviderSkill?.name ?? activeProviderSkillRow?.label ?? 'No skill selected'}</Text>
                  <Text color={palette.dim}>
                    {truncateEnd(activeProviderSkill?.description ?? activeProviderSkillRow?.detail ?? ' ', 94)}
                  </Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Space opens the selection action or removes a run-only skill. `V` previews SKILL.md.</HintLine>
                  <HintLine>
                    {`Enter continues to ${activeHome.value === 'create-prd' ? 'the PRD brief editor' : 'PRD selection'}. Left arrow returns to provider choice.`}
                  </HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'provider-skill-action' && providerSkillDecision && (
              <SectionPanel title="Choose skill usage" subtitle={providerSkillDecision.skill.name.toUpperCase()} flexGrow={1}>
                <Text color={palette.dim}>
                  Decide whether this skill should apply only to the current execution or become a project default for {activeProvider.value}.
                </Text>
                <Box marginTop={1} flexDirection="column">
                  {providerSkillDecisionOptions.map((option, index) => (
                    <ChoiceRow compact
                      key={option.value}
                      active={index === providerSkillActionIndex}
                      label={option.label}
                      description={option.description}
                    />
                  ))}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Source: {truncateMiddle(providerSkillSourceDir(providerSkillDecision.skill), 72)}</HintLine>
                  <HintLine>Enter confirms. Left arrow returns to the skill list.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'environment' && (
              <SectionPanel title="Choose runtime" subtitle="EXECUTION" flexGrow={1}>
                {availableEnvironmentOptions.map((option, index) => (
                  <ChoiceRow compact key={option.value} active={index === environmentIndex} label={option.label} description={option.description} />
                ))}
                <Box marginTop={1} flexDirection="column">
                  <HintLine>
                    {projectBootstrap.devcontainerConfigPath || initial.devcontainerConfigPath
                      ? `Devcontainer config: ${displayPath(projectBootstrap.devcontainerConfigPath ?? initial.devcontainerConfigPath ?? '', rootDir)}`
                      : 'No devcontainer config was found, so local runtime is the only available option.'}
                  </HintLine>
                  <HintLine>Enter continues to scheduling. Left arrow returns to execution skill selection.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'schedule' && (
              <SectionPanel title="Choose execution strategy" subtitle="ORCHESTRATION" flexGrow={1}>
                {scheduleOptions.map((option, index) => (
                  <ChoiceRow compact key={option.value} active={index === scheduleIndex} label={option.value} description={option.description} />
                ))}
                <HintLine>
                  {selectedPrdPaths.length === 1
                    ? 'Single-PRD parallel runs will fan out into multiple versions in the next step.'
                    : 'Multi-PRD runs always use worktrees so Ralphi can isolate branches, honor dependencies, and keep a final merged branch.'}
                </HintLine>
              </SectionPanel>
            )}

            {screen === 'iterations' && (
              <SectionPanel title="Configure PRD passes" subtitle={activeSchedule.value.toUpperCase()} flexGrow={1}>
                <HintLine>{iterationWindow.start > 0 ? `↑ ${iterationWindow.start} more above` : ' '}</HintLine>
                {iterationWindow.values.map((entry, index) => {
                  const absoluteIndex = iterationWindow.start + index;
                  return <SelectRow key={entry.key} active={absoluteIndex === iterationCursor} label={entry.label} detail={entry.detail} />;
                })}
                <HintLine>{iterationItemsBelow > 0 ? `↓ ${iterationItemsBelow} more below` : ' '}</HintLine>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Use digits, +, -, Backspace, and Enter.</HintLine>
                  <HintLine>Each value is a full PRD pass across its backlog, not a single backlog-item turn.</HintLine>
                  <HintLine>Schedules drive this screen: parallel single-PRD runs expose version count first.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'token-budget' && (
              <SectionPanel title="Set execution token budget" subtitle="GUARDRAIL" flexGrow={1}>
                <LabelValue label="Status" value={tokenBudgetEnabled ? 'enabled' : 'unlimited'} />
                <LabelValue
                  label="Limit"
                  value={tokenBudgetEnabled ? (parsedTokenBudget ? `${parsedTokenBudget.toLocaleString('en-US')} tokens` : tokenBudgetInput || 'pending') : 'No limit'}
                />
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.dim}>
                    Ralphi pauses once the full execution reaches this token budget and waits for you to abort, continue with a new limit, or continue without limits.
                  </Text>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Space toggles the guardrail. Digits and Backspace edit the limit.</HintLine>
                  <HintLine>Enter continues to launch review. The limit always starts from zero for a fresh run.</HintLine>
                </Box>
              </SectionPanel>
            )}

            {screen === 'review' && (
              <SectionPanel title="Review launch plan" subtitle="READY" flexGrow={1}>
                <LabelValue label="Context" value={contextLabel(initial.projectContextMode)} />
                <LabelValue label="Provider" value={activeProvider.value} />
                <LabelValue label="Skills" value={String(activeExecutionSkills.length)} />
                <LabelValue label="Schedule" value={pickScheduleLabel(activeSchedule.value)} />
                <LabelValue label="Workspace" value={launchPlanWorkspaceStrategy} />
                <LabelValue label="Token budget" value={parsedTokenBudget ? `${parsedTokenBudget.toLocaleString('en-US')} tokens` : 'unlimited'} />
                <LabelValue label="PRDs" value={String(selectedPrdPaths.length)} />
                {dependencyCount > 0 ? <LabelValue label="Dependencies" value={String(dependencyCount)} /> : null}
                {activeSchedule.value === 'parallel' && selectedPrdPaths.length === 1 ? <LabelValue label="Variants" value={String(plans.length)} /> : null}
                <Box marginTop={1} flexDirection="column">
                  {plans.map(plan => {
                    const dependencyPlan = plan.dependsOn ? plans.find(candidate => candidate.id === plan.dependsOn) ?? null : null;
                    return (
                      <Text key={plan.id} color={palette.text}>
                        {`• ${displayPath(plan.sourcePrd, rootDir)} · ${plan.iterations} PRD passes · ${plan.branchName}${dependencyPlan ? ` · depends on ${path.basename(dependencyPlan.sourcePrd)}` : ''}`}
                      </Text>
                    );
                  })}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.accent}>Execution skills</Text>
                  {activeExecutionSkills.length === 0 ? <Text color={palette.dim}>No additional provider skills selected for this run.</Text> : null}
                  {activeExecutionSkills.map(skill => (
                    <Text key={skill.id} color={palette.text}>
                      {`• ${skill.name} · ${skill.persisted ? 'default' : 'this run'}`}
                    </Text>
                  ))}
                </Box>
                {launchDoctorReport ? (
                  <Box marginTop={1} flexDirection="column">
                    <Text color={launchDoctorReport.status === 'blocking' ? palette.danger : palette.accent}>
                      {`Preflight · ${doctorSummaryLine(launchDoctorReport)}`}
                    </Text>
                    {(launchDoctorReport.status === 'ok'
                      ? ['[ok] No warnings or blockers detected.']
                      : doctorCheckRows(launchDoctorReport).filter(row => row.startsWith('[warning]') || row.startsWith('[blocking]'))
                    ).map(row => (
                      <Text
                        key={row}
                        color={row.startsWith('[blocking]') ? palette.danger : row.startsWith('[warning]') ? palette.text : palette.dim}
                      >
                        {row}
                      </Text>
                    ))}
                    {launchDoctorReport.status === 'blocking' ? (
                      <HintLine>Blocking checks prevent launch until the issue is fixed.</HintLine>
                    ) : null}
                  </Box>
                ) : null}
                <Box marginTop={1} flexDirection="column">
                  <HintLine>{backlogWindow.start > 0 ? `↑ ${backlogWindow.start} more above` : ' '}</HintLine>
                  {backlogWindow.values.map((row, index) => {
                    const absoluteIndex = backlogWindow.start + index;
                    return (
                      <SelectRow
                        key={`review:${row.prdPath}:${row.itemId ?? 'root'}:${row.kind}`}
                        active={absoluteIndex === backlogCursor}
                        label={row.label}
                        detail={truncateEnd(row.detail, 18)}
                      />
                    );
                  })}
                  <HintLine>{backlogItemsBelow > 0 ? `↓ ${backlogItemsBelow} more below` : ' '}</HintLine>
                </Box>
                <Box marginTop={1} flexDirection="column">
                  {selectedPrdPaths.length > 1 ? <HintLine>Ralphi will keep the final merged branch and clean only this execution’s individual PRD branches/worktrees.</HintLine> : null}
                  <Text color={palette.dim}>
                    Enter launches. P views PRD, R edits PRD, V opens backlog.
                  </Text>
                </Box>
              </SectionPanel>
            )}

            {(screen === 'skills-menu' ||
              screen === 'skill-catalog' ||
              screen === 'skill-view' ||
              screen === 'skill-input' ||
              screen === 'skill-target' ||
              screen === 'skill-scope' ||
              screen === 'skill-progress') && (
              <SectionPanel
                title={
                  screen === 'skills-menu'
                    ? 'Manage skills'
                    : screen === 'skill-catalog'
                      ? 'Browse official skills'
                      : screen === 'skill-view'
                        ? viewer?.title ?? 'Skill preview'
                        : screen === 'skill-input'
                          ? 'Add a GitHub skill'
                          : screen === 'skill-target'
                            ? 'Choose provider target'
                            : screen === 'skill-scope'
                              ? 'Choose install scope'
                              : 'Installing skills'
                }
                subtitle={
                  screen === 'skill-catalog'
                    ? skillSource === 'openai'
                      ? 'OPENAI'
                      : 'CLAUDE'
                    : screen === 'skill-view'
                      ? viewer?.subtitle ?? 'PREVIEW'
                      : 'SKILLS'
                }
                flexGrow={1}
              >
                {screen === 'skills-menu' && (
                  <Box flexDirection="column">
                    {skillMenuOptions.map((option, index) => (
                      <ChoiceRow compact key={option.value} active={index === skillMenuIndex} label={option.label} description={option.description} />
                    ))}
                    <Box marginTop={1} flexDirection="column">
                      <Text color={palette.accent}>Built-in skills</Text>
                      {builtinSkillRows.length === 0 ? <Text color={palette.dim}>No built-in skills detected.</Text> : null}
                      {builtinSkillRows.map(skill => (
                        <Text key={`builtin-${skill.name}`} color={palette.text}>{`• ${skill.name} · ${truncateEnd(skill.description, 52)}`}</Text>
                      ))}
                    </Box>
                    <Box marginTop={1} flexDirection="column">
                      <Text color={palette.accent}>Project skills</Text>
                      {projectSkillRows.length === 0 ? <Text color={palette.dim}>No project skills installed yet.</Text> : null}
                      {projectSkillRows.map(skill => (
                        <Text key={`project-${skill.target}-${skill.name}`} color={palette.text}>
                          {`• ${skill.name} · ${skill.target} · ${truncateEnd(skill.description, 44)}`}
                        </Text>
                      ))}
                    </Box>
                    <Box marginTop={1} flexDirection="column">
                      <Text color={palette.accent}>Global skills</Text>
                      {globalSkillRows.length === 0 ? <Text color={palette.dim}>No global skills installed yet.</Text> : null}
                      {globalSkillRows.map(skill => (
                        <Text key={`global-${skill.target}-${skill.name}`} color={palette.text}>
                          {`• ${skill.name} · ${skill.target} · ${truncateEnd(skill.description, 44)}`}
                        </Text>
                      ))}
                    </Box>
                    <Box marginTop={1} flexDirection="column">
                      <HintLine>Project dirs: {displayPath(projectProviderSkillDir(rootDir, 'codex'), rootDir)} · {displayPath(projectProviderSkillDir(rootDir, 'claude'), rootDir)} · {displayPath(projectProviderSkillDir(rootDir, 'copilot'), rootDir)} · {displayPath(projectProviderSkillDir(rootDir, 'amp'), rootDir)} · {displayPath(projectProviderSkillDir(rootDir, 'opencode'), rootDir)} · {displayPath(projectProviderSkillDir(rootDir, 'qwen'), rootDir)}</HintLine>
                      <HintLine>Global dirs: {displayPathFromHome(globalProviderSkillDir('codex'), os.homedir())} · {displayPathFromHome(globalProviderSkillDir('claude'), os.homedir())} · {displayPathFromHome(globalProviderSkillDir('copilot'), os.homedir())} · {displayPathFromHome(globalProviderSkillDir('amp'), os.homedir())} · {displayPathFromHome(globalProviderSkillDir('opencode'), os.homedir())} · {displayPathFromHome(globalProviderSkillDir('qwen'), os.homedir())}</HintLine>
                    </Box>
                  </Box>
                )}

                {screen === 'skill-catalog' && (
                  <Box flexDirection="column">
                    <Text color={palette.dim}>
                      Browse the official catalog, preview the skill before installing, and select one or more entries for the same batch.
                    </Text>
                    <HintLine>{skillCatalogWindow.start > 0 ? `↑ ${skillCatalogWindow.start} more above` : ' '}</HintLine>
                    {skillCatalogWindow.values.map((entry, index) => {
                      const absoluteIndex = skillCatalogWindow.start + index;
                      return (
                        <SelectRow
                          key={entry.id}
                          active={absoluteIndex === skillCatalogCursor}
                          checked={selectedCatalogIds.has(entry.id)}
                          label={entry.name}
                          detail={entry.catalogLabel}
                        />
                      );
                    })}
                    <HintLine>{skillCatalogItemsBelow > 0 ? `↓ ${skillCatalogItemsBelow} more below` : ' '}</HintLine>
                    <Box marginTop={1} flexDirection="column">
                      <Text color={palette.accent}>{activeSkillCatalogEntry?.name ?? 'No skill selected'}</Text>
                      <Text color={palette.dim}>{truncateEnd(activeSkillCatalogEntry?.description ?? ' ', 94)}</Text>
                    </Box>
                    <Box marginTop={1} flexDirection="column">
                      <HintLine>Space toggles a skill. `V` opens the preview. Enter continues with the selected batch.</HintLine>
                      <HintLine>If nothing is selected, Enter continues with the highlighted skill.</HintLine>
                    </Box>
                  </Box>
                )}

                {screen === 'skill-view' && viewer && (
                  <Box flexDirection="column" flexGrow={1}>
                    <HintLine>{viewerWindow.start > 0 ? `↑ ${viewerWindow.start} more above` : ' '}</HintLine>
                    {viewerWindow.values.map((line, index) => (
                      <Text key={`skill-view-${index}`} color={palette.text}>
                        {line || ' '}
                      </Text>
                    ))}
                    <HintLine>{viewerLinesBelow > 0 ? `↓ ${viewerLinesBelow} more below` : ' '}</HintLine>
                    <HintLine>
                      {viewer.returnScreen === 'skill-input'
                        ? 'Use ↑ ↓ to scroll. Enter continues to provider target selection. Left arrow returns to the GitHub input.'
                        : 'Use ↑ ↓ to scroll. Enter or Left arrow returns to the catalog.'}
                    </HintLine>
                  </Box>
                )}

                {screen === 'skill-input' && (
                  <Box flexDirection="column">
                    <Text color={palette.dim}>
                      Enter `owner/repo:path/to/skill` or a GitHub tree URL. Ralphi will preview the skill first so you can inspect its instructions and requirements before installing.
                    </Text>
                    <Box marginTop={1} borderStyle="round" borderColor={palette.borderSoft} paddingX={1}>
                      <Text color={palette.text}>{skillInput || ' '}</Text>
                    </Box>
                    <Box marginTop={1} flexDirection="column">
                      <HintLine>Example: `anthropics/skills:skills/development-technical/dev-browser`</HintLine>
                      <HintLine>Enter opens the preview. Backspace edits.</HintLine>
                      <HintLine>Character shortcuts stay local to this input while you type.</HintLine>
                    </Box>
                  </Box>
                )}

                {screen === 'skill-target' && (
                  <Box flexDirection="column">
                    <Text color={palette.dim}>
                      Choose which provider should own this GitHub skill. Ralphi will install it into that provider’s standard skill directory so the CLI can discover it automatically.
                    </Text>
                    <Box marginTop={1} flexDirection="column">
                      {skillTargetOptions.map((option, index) => (
                        <ChoiceRow compact key={option.value} active={index === skillTargetIndex} label={option.label} description={option.description} />
                      ))}
                    </Box>
                    <Box marginTop={1} flexDirection="column">
                      <HintLine>Skill: {pendingSkillInstalls[0]?.name ?? 'None selected yet'}</HintLine>
                      <HintLine>Enter confirms the target. Left arrow returns to the GitHub input.</HintLine>
                    </Box>
                  </Box>
                )}

                {screen === 'skill-scope' && (
                  <Box flexDirection="column">
                    <Text color={palette.dim}>
                      Decide whether these skills should live in the current project or in your global provider skill directory.
                    </Text>
                    <Box marginTop={1} flexDirection="column">
                      {scopeOptions.map((option, index) => (
                        <ChoiceRow compact
                          key={option.value}
                          active={index === scopeIndex}
                          label={option.value}
                          description={scopeDescriptionForTarget(rootDir, option.value, pendingSkillTarget)}
                        />
                      ))}
                    </Box>
                    <Box marginTop={1} flexDirection="column">
                      <HintLine>{`${pendingSkillInstalls.length} skill${pendingSkillInstalls.length === 1 ? '' : 's'} queued for install.`}</HintLine>
                      <HintLine>
                        {`Target dir base: ${displayPath(projectProviderSkillDir(rootDir, pendingSkillTarget), rootDir)} / ${displayPathFromHome(globalProviderSkillDir(pendingSkillTarget), os.homedir())}`}
                      </HintLine>
                    </Box>
                  </Box>
                )}

                {screen === 'skill-progress' && (
                  <Box flexDirection="column" justifyContent="center" flexGrow={1}>
                    <Spinner label={skillInstallProgress?.currentLabel ? `Installing ${skillInstallProgress.currentLabel}` : busyMessage ?? 'Installing skills'} />
                    {skillInstallProgress ? (
                      <Box marginTop={1} flexDirection="column">
                        <ProgressBar value={skillInstallProgressValue(skillInstallProgress)} />
                        <Box marginTop={1} flexDirection="column">
                          <Text color={palette.accent}>{`Skill ${Math.min(skillInstallProgress.current + 1, skillInstallProgress.total)}/${skillInstallProgress.total}`}</Text>
                          <Text color={palette.dim}>{skillInstallProgress.currentLabel}</Text>
                          {skillInstallProgress.history.map(entry => (
                            <Text key={entry} color={palette.dim}>
                              {entry}
                            </Text>
                          ))}
                        </Box>
                      </Box>
                    ) : null}
                    <Box marginTop={1}>
                      <Text color={palette.dim}>Ralphi is downloading the selected skill package and updating the target directory.</Text>
                    </Box>
                    <Box marginTop={1}>
                      <HintLine>Press G to open the ARCADE menu while the install finishes.</HintLine>
                    </Box>
                  </Box>
                )}
              </SectionPanel>
            )}

            {!compact && screen !== 'about' ? (
              <Box marginTop={1}>
                <SectionPanel title="Mission brief" subtitle="STACK" flexGrow={1}>
                  <Text color={palette.text}>
                    Ralphi keeps execution state in `./.ralphi/state`, lets you choose PRD/backlog skills from built-in or provider-standard directories, and refreshes backlog state before launch.
                  </Text>
                <Box marginTop={1} flexDirection="column">
                  <HintLine>Root: {displayPath(rootDir, rootDir) || '.'}</HintLine>
                  <HintLine>Project config: .ralphi.json</HintLine>
                  <HintLine>Built-in skills: ./ralph/skills</HintLine>
                  <HintLine>Project provider dirs: ./.codex/skills/public · ./.claude/skills · ./.github/skills · ./.agents/skills · ./.opencode/skills · ./.qwen/skills</HintLine>
                  <HintLine>Global provider dirs: ~/.codex/skills/public · ~/.claude/skills · ~/.copilot/skills · ~/.config/agents/skills · ~/.config/opencode/skills · ~/.qwen/skills</HintLine>
                  <HintLine>Gemini uses GEMINI.md and ./.gemini/commands; Cursor uses AGENTS.md plus ./.cursor/rules instead of SKILL.md directories.</HintLine>
                  <HintLine>Defaults are copied only when the selected skill is outside the canonical provider directory.</HintLine>
                </Box>
              </SectionPanel>
            </Box>
          ) : null}
              </>
            )}

            {notice || installError ? (
              <Box marginTop={1}>
                <Text color={installError ? palette.danger : palette.yellow}>{installError ?? notice}</Text>
              </Box>
            ) : null}
          </Box>
        </Box>
      </WindowFrame>
    </ThemeProvider>
  );
}

export async function runWizard(props: WizardProps): Promise<RalphConfig> {
  return new Promise<RalphConfig>((resolve, reject) => {
    const { waitUntilExit } = render(
      <WizardApp
        {...props}
        onComplete={resolve}
        onCancel={() => {
          reject(new Error('Aborted.'));
        }}
      />
    );

    void waitUntilExit().catch(reject);
  });
}
