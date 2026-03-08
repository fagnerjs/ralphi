import { stripVTControlCharacters } from 'node:util';

import React, { startTransition, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, render, Text, useApp, useInput } from 'ink';
import { Badge, ProgressBar, Spinner, ThemeProvider } from '@inkjs/ui';

import { sortPlansByDependencies } from '../core/dependencies.js';
import { failureCategoryLabel } from '../core/failure.js';
import { createGitPullRequest } from '../core/git.js';
import { runRalphi } from '../core/runtime.js';
import { prepareContextRetry } from '../core/session.js';
import type {
  BacklogStatus,
  BacklogStep,
  DoctorReport,
  GitValidation,
  RalphConfig,
  RalphContextSnapshot,
  RalphEvent,
  RalphPrdPlan,
  RalphRunSummary
} from '../core/types.js';
import {
  aggregateUsageTotals,
  buildCompactUsageSummary,
  buildTokensUsedLabel,
  buildUsageDisplayRows,
  formatUsageTokenTotal,
  hasUsageTotals
} from '../core/usage.js';
import { displayPath, pickScheduleLabel, truncateEnd, truncateMiddle } from '../core/utils.js';
import { ArcadeCabinet } from './arcade.js';
import { AsciiLogo, HintLine, LabelValue, SectionPanel, SystemTabs, WindowFrame } from './components.js';
import { useTerminalViewport } from './terminal.js';
import { palette, systemTheme } from './theme.js';

interface DashboardState {
  phase: 'booting' | 'running' | 'done' | 'error';
  contexts: RalphContextSnapshot[];
  activeContextIndex: number | null;
  activeStep: string;
  waveLabel: string;
  eventLog: string[];
  outputLogByContext: Record<number, SignalOutputEntry[]>;
  nextOutputId: number;
  summary: RalphRunSummary | null;
  gitValidation: GitValidation | null;
  doctorReport: DoctorReport | null;
  projectConfigPath: string | null;
  missingSkillCount: number;
  notifications: DashboardNotification[];
  nextNotificationId: number;
}

interface DashboardResult {
  summary: RalphRunSummary;
  nextAction: 'exit' | 'restart-wizard' | 'resume-session' | 'restart-session' | 'discard-session';
}

interface DashboardNotification {
  id: number;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string;
}

const initialState: DashboardState = {
  phase: 'booting',
  contexts: [],
  activeContextIndex: null,
  activeStep: 'Preparing workspace',
  waveLabel: 'Boot sequence',
  eventLog: [],
  outputLogByContext: {},
  nextOutputId: 1,
  summary: null,
  gitValidation: null,
  doctorReport: null,
  projectConfigPath: null,
  missingSkillCount: 0,
  notifications: [],
  nextNotificationId: 1
};

export function createInitialDashboardState(): DashboardState {
  return {
    ...initialState,
    contexts: [],
    eventLog: [],
    outputLogByContext: {},
    summary: null,
    gitValidation: null,
    doctorReport: null,
    projectConfigPath: null,
    notifications: []
  };
}

function resolveQueuePlanIds(plans: RalphPrdPlan[]): string[] {
  try {
    return sortPlansByDependencies(plans).map(plan => plan.id);
  } catch {
    return plans.map(plan => plan.id);
  }
}

function compareQueueOrder(
  leftPlanId: string,
  rightPlanId: string,
  orderIndex: Map<string, number>,
  leftFallback: number,
  rightFallback: number
): number {
  const leftOrder = orderIndex.get(leftPlanId);
  const rightOrder = orderIndex.get(rightPlanId);

  if (leftOrder !== undefined || rightOrder !== undefined) {
    if (leftOrder === undefined) {
      return 1;
    }

    if (rightOrder === undefined) {
      return -1;
    }

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
  }

  return leftFallback - rightFallback;
}

function orderPlansForQueue(plans: RalphPrdPlan[]): RalphPrdPlan[] {
  const orderIndex = new Map(resolveQueuePlanIds(plans).map((planId, index) => [planId, index] as const));
  const fallbackIndex = new Map(plans.map((plan, index) => [plan.id, index] as const));

  return [...plans].sort((left, right) =>
    compareQueueOrder(
      left.id,
      right.id,
      orderIndex,
      fallbackIndex.get(left.id) ?? 0,
      fallbackIndex.get(right.id) ?? 0
    )
  );
}

export function orderContextsForQueue(contexts: RalphContextSnapshot[], plans: RalphPrdPlan[]): RalphContextSnapshot[] {
  const orderIndex = new Map(resolveQueuePlanIds(plans).map((planId, index) => [planId, index] as const));

  return [...contexts].sort((left, right) => compareQueueOrder(left.planId, right.planId, orderIndex, left.index, right.index));
}

function pushLimited<T>(items: T[], value: T, limit: number): T[] {
  const next = [...items, value];
  return next.slice(Math.max(0, next.length - limit));
}

function pushContextOutput(
  items: Record<number, SignalOutputEntry[]>,
  contextIndex: number,
  line: SignalOutputEntry,
  limit: number
): Record<number, SignalOutputEntry[]> {
  return {
    ...items,
    [contextIndex]: pushLimited(items[contextIndex] ?? [], line, limit)
  };
}

type SignalTone = 'default' | 'success' | 'error' | 'command' | 'diff-add' | 'diff-remove' | 'diff-hunk' | 'marker' | 'file';

interface SignalOutputEntry {
  id: number;
  text: string;
  tone: SignalTone;
}

interface ChecklistDisplayLine {
  key: string;
  marker: string;
  markerColor: string;
  text: string;
}

interface SignalDisplayLine {
  key: string;
  text: string;
  tone: SignalTone;
}

interface WrappedTextLine {
  key: string;
  text: string;
}

type DashboardAction =
  | RalphEvent
  | { type: 'batch'; events: RalphEvent[] }
  | { type: 'runtime-error'; message: string };

function sanitizeDashboardLine(line: string): string {
  return stripVTControlCharacters(line)
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .trimEnd();
}

function wrapDashboardLine(line: string, width: number): string[] {
  const safeWidth = Math.max(8, width);
  const cleanLine = sanitizeDashboardLine(line);

  if (!cleanLine) {
    return [''];
  }

  const wrapped: string[] = [];

  for (const sourceLine of cleanLine.split(/\r?\n/)) {
    if (!sourceLine) {
      wrapped.push('');
      continue;
    }

    let cursor = 0;
    while (cursor < sourceLine.length) {
      wrapped.push(sourceLine.slice(cursor, cursor + safeWidth));
      cursor += safeWidth;
    }
  }

  return wrapped;
}

export function classifySignalTone(line: string): SignalTone {
  const lower = line.toLowerCase();

  if (line.startsWith('@@')) {
    return 'diff-hunk';
  }

  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'diff-add';
  }

  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'diff-remove';
  }

  if (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('exception') ||
    lower.includes('traceback') ||
    lower.includes('not found') ||
    lower.includes('invalid ')
  ) {
    return 'error';
  }

  if (lower.includes('<promise>complete</promise>') || lower.includes('updated the following files') || lower.includes('created pull request')) {
    return 'success';
  }

  if (lower.includes('<ralphi-backlog') || lower.includes('<promise>')) {
    return 'marker';
  }

  if (
    line.startsWith('*** Update File:') ||
    line.startsWith('*** Add File:') ||
    line.startsWith('*** Delete File:') ||
    /\b[\w./-]+\.(ts|tsx|js|jsx|json|md|py|sh|css|yml|yaml|toml|go|rs|java|rb|php)\b/.test(line)
  ) {
    return 'file';
  }

  if (
    /^\s*(\$|>|›)\s/.test(line) ||
    /\b(git|npm|pnpm|yarn|bun|node|npx|pytest|vitest|jest|cargo|go test|rg|sed|cat|ls|find|bash|sh)\b/i.test(line)
  ) {
    return 'command';
  }

  return 'default';
}

function signalToneColor(tone: SignalTone): string {
  switch (tone) {
    case 'success':
      return palette.green;
    case 'error':
      return palette.danger;
    case 'command':
      return palette.cyan;
    case 'diff-add':
      return palette.green;
    case 'diff-remove':
      return palette.danger;
    case 'diff-hunk':
      return palette.yellow;
    case 'marker':
      return palette.accent;
    case 'file':
      return palette.accentSoft;
    default:
      return palette.text;
  }
}

function backlogStatusBadge(status: BacklogStatus): { color: 'green' | 'yellow' | 'red' | 'blue'; label: string } {
  switch (status) {
    case 'done':
      return { color: 'green', label: 'done' };
    case 'in_progress':
      return { color: 'blue', label: 'live' };
    case 'blocked':
      return { color: 'red', label: 'blocked' };
    case 'disabled':
      return { color: 'yellow', label: 'disabled' };
    default:
      return { color: 'yellow', label: 'pending' };
  }
}

function buildTailDisplayLines(entries: SignalOutputEntry[], width: number, lineLimit: number): SignalDisplayLine[] {
  const wrapped = entries.flatMap(entry =>
    wrapDashboardLine(entry.text, width).map((text, index) => ({
      key: `${entry.id}:${index}`,
      text,
      tone: entry.tone
    }))
  );
  return wrapped.slice(Math.max(0, wrapped.length - Math.max(1, lineLimit)));
}

function buildWrappedTextLines(entries: string[], width: number, lineLimit: number): WrappedTextLine[] {
  const wrapped = entries.flatMap((entry, entryIndex) =>
    wrapDashboardLine(entry, width).map((text, segmentIndex) => ({
      key: `${entryIndex}:${segmentIndex}`,
      text
    }))
  );
  return wrapped.slice(Math.max(0, wrapped.length - Math.max(1, lineLimit)));
}

function checklistMarker(step: BacklogStep): { marker: string; color: string } {
  if (step.status === 'done') {
    return { marker: '✓ ', color: palette.green };
  }

  if (step.status === 'in_progress') {
    return { marker: '▶ ', color: palette.accent };
  }

  return { marker: '· ', color: palette.dim };
}

function buildChecklistDisplayLines(
  steps: BacklogStep[],
  width: number,
  lineLimit: number
): { lines: ChecklistDisplayLine[]; hiddenSteps: number } {
  const lines: ChecklistDisplayLine[] = [];
  let visibleSteps = 0;

  for (const step of steps) {
    const marker = checklistMarker(step);
    const wrapped = wrapDashboardLine(step.title, Math.max(8, width - 2));

    if (lines.length + wrapped.length > lineLimit) {
      break;
    }

    visibleSteps += 1;
    wrapped.forEach((segment, index) => {
      lines.push({
        key: `${step.id}:${index}`,
        marker: index === 0 ? marker.marker : '  ',
        markerColor: marker.color,
        text: segment
      });
    });
  }

  return {
    lines,
    hiddenSteps: Math.max(0, steps.length - visibleSteps)
  };
}

function notificationColor(level: DashboardNotification['level']): string {
  switch (level) {
    case 'success':
      return palette.green;
    case 'warning':
      return palette.yellow;
    case 'error':
      return palette.danger;
    default:
      return palette.accent;
  }
}

function pushNotification(
  state: DashboardState,
  notification: Omit<DashboardNotification, 'id'>
): Pick<DashboardState, 'notifications' | 'nextNotificationId'> {
  return {
    notifications: pushLimited(
      state.notifications,
      {
        id: state.nextNotificationId,
        ...notification
      },
      6
    ),
    nextNotificationId: state.nextNotificationId + 1
  };
}

export function buildRunSummaryText(summary: RalphRunSummary): string {
  const completed = summary.contexts.filter(context => isContextComplete(context)).length;
  const commits = summary.contexts.filter(context => Boolean(context.commitSha)).length;
  const pending = Math.max(0, summary.contexts.length - completed);
  const usageSummary = buildCompactUsageSummary(
    summary.usageTotals ?? aggregateUsageTotals(summary.contexts.map(context => resolveContextUsageTotals(context)))
  );

  if (pending > 0) {
    const reason = buildSummaryPauseReason(summary);
    return `${completed}/${summary.contexts.length} PRDs complete. ${pending} still need attention, and you can resume from the saved checkpoint.${reason ? ` Reason: ${reason}.` : ''}${usageSummary ? ` Usage: ${usageSummary}.` : ''}`;
  }

  const finalBranchSummary = summary.finalBranchName ? ` Final branch: ${summary.finalBranchName}.` : '';
  return `${completed}/${summary.contexts.length} PRDs complete with ${commits} commit${commits === 1 ? '' : 's'} ready for review.${finalBranchSummary}${usageSummary ? ` Usage: ${usageSummary}.` : ''}`;
}

export function buildContextPauseReason(context: RalphContextSnapshot | null | undefined): string | null {
  if (!context || isContextComplete(context)) {
    return null;
  }

  const failureSummary = context.lastFailure?.summary ?? context.lastError;
  if (failureSummary) {
    return `blocked by error: ${failureSummary}`;
  }

  if (context.iterationsTarget > 0 && context.iterationsRun >= context.iterationsTarget) {
    return `stopped after ${context.iterationsRun}/${context.iterationsTarget} iteration${context.iterationsTarget === 1 ? '' : 's'} with work still pending`;
  }

  return 'work still pending';
}

export function buildSummaryPauseReason(summary: RalphRunSummary): string | null {
  if (summary.completed) {
    return null;
  }

  if (summary.contexts.length === 1) {
    return buildContextPauseReason(summary.contexts[0]);
  }

  const pendingContexts = summary.contexts.filter(context => !isContextComplete(context));
  const blocked = pendingContexts.filter(context => Boolean(context.lastFailure?.summary ?? context.lastError)).length;
  const iterationLimited = pendingContexts.filter(
    context =>
      !Boolean(context.lastFailure?.summary ?? context.lastError) &&
      context.iterationsTarget > 0 &&
      context.iterationsRun >= context.iterationsTarget
  ).length;
  const parts: string[] = [];

  if (iterationLimited > 0) {
    parts.push(`${iterationLimited} reached the configured iteration limit`);
  }

  if (blocked > 0) {
    parts.push(`${blocked} blocked by errors`);
  }

  if (parts.length === 0) {
    return pendingContexts.length > 0 ? `${pendingContexts.length} still need attention` : null;
  }

  return parts.join('; ');
}

export function completedEarly(context: RalphContextSnapshot | null | undefined): boolean {
  if (!context || !isContextComplete(context)) {
    return false;
  }

  return context.iterationsTarget > 0 && context.iterationsRun < context.iterationsTarget;
}

export function formatContextIterations(context: RalphContextSnapshot | null | undefined): string {
  if (!context) {
    return 'n/a';
  }

  const progress = `${context.iterationsRun}/${context.iterationsTarget}`;
  return completedEarly(context) ? `${progress} used · completed early` : progress;
}

function buildRunCompletionStatus(summary: RalphRunSummary): string {
  if (summary.completed) {
    return 'All tasks complete';
  }

  const pendingContexts = summary.contexts.filter(context => !isContextComplete(context));
  if (pendingContexts.length === 1) {
    const pendingContext = pendingContexts[0];
    if (pendingContext && !pendingContext.lastFailure && !pendingContext.lastError && pendingContext.iterationsTarget > 0 && pendingContext.iterationsRun >= pendingContext.iterationsTarget) {
      return `Paused after ${pendingContext.iterationsRun}/${pendingContext.iterationsTarget} iteration${pendingContext.iterationsTarget === 1 ? '' : 's'}`;
    }
  }

  const blockedCount = pendingContexts.filter(context => Boolean(context.lastFailure?.summary ?? context.lastError)).length;
  if (blockedCount > 0 && blockedCount === pendingContexts.length) {
    return blockedCount === 1 ? 'Blocked by error' : 'Blocked by errors';
  }

  return 'Pending work remains';
}

export function resolveContextUsageTotals(
  context: RalphContextSnapshot | null | undefined
): RalphContextSnapshot['usageTotals'] {
  if (!context) {
    return null;
  }

  return context.usageTotals ?? aggregateUsageTotals(context.iterationHistory.map(entry => entry.usageTotals));
}

export function buildCompletionUsageRows(
  usage: RalphRunSummary['usageTotals'] | RalphContextSnapshot['usageTotals']
): Array<{ label: string; value: string }> {
  const rows = buildUsageDisplayRows(usage);
  const spendRow = rows.find(row => row.label === 'Spend');
  const totalTokensRow = rows.find(row => row.label === 'Tokens');

  if (totalTokensRow) {
    return spendRow ? [totalTokensRow, spendRow] : [totalTokensRow];
  }

  if (!hasUsageTotals(usage)) {
    return spendRow ? [spendRow] : [];
  }

  const tokenBreakdown = rows
    .filter(row => row.label === 'Input' || row.label === 'Cached' || row.label === 'Output' || row.label === 'Reasoning')
    .map(row => `${row.label.toLowerCase()} ${row.value}`)
    .join(' · ');

  const fallbackRows = tokenBreakdown ? [{ label: 'Tokens', value: tokenBreakdown }] : [];
  return spendRow ? [...fallbackRows, spendRow] : fallbackRows;
}

function buildFailureSuggestion(message: string, context: RalphContextSnapshot | null): string {
  if (context?.lastFailure?.recoveryHint) {
    return context.lastFailure.recoveryHint;
  }

  const lower = message.toLowerCase();

  if (lower.includes('not found in path')) {
    return 'Install the provider CLI, confirm it is available in PATH, then resume from the saved checkpoint.';
  }

  if (lower.includes('timed out')) {
    return 'Inspect the latest log, reduce the task scope if needed, then resume from the saved checkpoint.';
  }

  if (lower.includes('git') || lower.includes('worktree')) {
    return 'Fix the Git/worktree state first, then resume from the saved checkpoint.';
  }

  if (context?.lastLogPath) {
    return `Inspect the latest log at ${context.lastLogPath}, fix the cause, then resume from the saved checkpoint.`;
  }

  return 'Inspect the latest execution output, fix the root cause, then resume from the saved checkpoint.';
}

function applyEvent(state: DashboardState, event: RalphEvent): DashboardState {
  switch (event.type) {
    case 'doctor-report':
      return {
        ...state,
        doctorReport: event.report,
        eventLog: pushLimited(
          state.eventLog,
          `Doctor: ${event.report.counts.ok} ok · ${event.report.counts.warning} warning · ${event.report.counts.blocking} blocking`,
          40
        )
      };
    case 'project-config':
      return {
        ...state,
        projectConfigPath: event.configPath,
        missingSkillCount: event.missingSkillCount,
        eventLog: pushLimited(state.eventLog, `Project config ready: ${event.configPath}`, 40)
      };
    case 'skill-sync-progress':
      return {
        ...state,
        eventLog: pushLimited(state.eventLog, `Skill sync ${event.current}/${event.total}: ${event.skill.name}`, 40)
      };
    case 'git-validation':
      return {
        ...state,
        gitValidation: event.validation,
        eventLog: pushLimited(
          state.eventLog,
          event.validation.repository
            ? `Git base: ${event.validation.currentBranch ?? 'detached'}${event.validation.clean ? '' : ' · dirty working tree'}`
            : 'Git repository unavailable. Shared workspace mode only.',
          40
        )
      };
    case 'boot-log':
      return event.level === 'error'
        ? {
            ...state,
            eventLog: pushLimited(state.eventLog, `[${event.level}] ${event.message}`, 40),
            ...pushNotification(state, {
              level: 'error',
              title: 'Execution error',
              body: `${event.message} ${buildFailureSuggestion(event.message, state.contexts[event.contextIndex ?? -1] ?? null)}`
            })
          }
        : {
        ...state,
        eventLog: pushLimited(state.eventLog, `[${event.level}] ${event.message}`, 40)
      };
    case 'prepared':
      return {
        ...state,
        phase: 'running',
        contexts: event.contexts,
        eventLog: pushLimited(state.eventLog, `Prepared ${event.contexts.length} PRD workstreams.`, 40),
        ...pushNotification(state, {
          level: 'info',
          title: 'Execution started',
          body: `${event.contexts.length} PRD workstream${event.contexts.length === 1 ? '' : 's'} prepared. Ralphi will keep saving checkpoints while the run is active.`
        })
      };
    case 'worktree-ready': {
      const nextContexts = [...state.contexts];
      nextContexts[event.context.index] = event.context;
      return {
        ...state,
        contexts: nextContexts,
        eventLog: pushLimited(state.eventLog, `${event.context.title}: worktree ready on ${event.context.branchName ?? 'shared'}.`, 40)
      };
    }
    case 'wave-start':
      return {
        ...state,
        waveLabel: `Wave ${event.wave}/${event.totalWaves}`,
        eventLog: pushLimited(state.eventLog, `Starting wave ${event.wave}/${event.totalWaves}.`, 40)
      };
    case 'track-start':
      return {
        ...state,
        activeContextIndex: event.contextIndex,
        eventLog: pushLimited(state.eventLog, `Switching focus to ${event.sourcePrd}.`, 40)
      };
    case 'backlog-update': {
      const nextContexts = [...state.contexts];
      const context = nextContexts[event.contextIndex];
      if (!context) {
        return state;
      }
      nextContexts[event.contextIndex] = {
        ...context,
        backlog: event.backlog,
        backlogProgress: `${event.backlog.completedItems}/${event.backlog.totalItems} tasks · ${event.backlog.completedSteps}/${event.backlog.totalSteps} steps`,
        activeBacklogItemId: event.itemId,
        activeBacklogStepId: event.stepId
      };
      return {
        ...state,
        contexts: nextContexts
      };
    }
    case 'iteration-start': {
      const nextContexts = [...state.contexts];
      nextContexts[event.context.index] = event.context;
      return {
        ...state,
        phase: 'running',
        contexts: nextContexts,
        activeContextIndex: event.context.index,
        activeStep: event.context.lastStep,
        outputLogByContext: {
          ...state.outputLogByContext,
          [event.context.index]: []
        },
        eventLog: pushLimited(state.eventLog, `${event.context.title}: iteration ${event.prdIteration} started.`, 40)
      };
    }
    case 'iteration-output': {
      const cleanLine = sanitizeDashboardLine(event.line);
      const nextContexts = [...state.contexts];
      const context = nextContexts[event.contextIndex];
      if (context) {
        nextContexts[event.contextIndex] = {
          ...context,
          lastStep: event.step,
          status: 'running'
        };
      }
      return {
        ...state,
        contexts: nextContexts,
        activeContextIndex: event.contextIndex,
        activeStep: event.step,
        outputLogByContext: cleanLine
          ? pushContextOutput(
              state.outputLogByContext,
              event.contextIndex,
              {
                id: state.nextOutputId,
                text: cleanLine,
                tone: classifySignalTone(cleanLine)
              },
              80
            )
          : state.outputLogByContext,
        nextOutputId: cleanLine ? state.nextOutputId + 1 : state.nextOutputId
      };
    }
    case 'usage-update': {
      const nextContexts = [...state.contexts];
      const context = nextContexts[event.contextIndex];
      if (!context) {
        return state;
      }

      nextContexts[event.contextIndex] = {
        ...context,
        usageTotals: event.usageTotals
      };

      return {
        ...state,
        contexts: nextContexts
      };
    }
    case 'iteration-finish': {
      const nextContexts = [...state.contexts];
      nextContexts[event.context.index] = event.context;
      const nextState: DashboardState = {
        ...state,
        contexts: nextContexts,
        activeContextIndex: event.context.index,
        activeStep: event.completed ? 'Completed' : event.step,
        eventLog: pushLimited(
          state.eventLog,
          `${event.context.title}: iteration ${event.prdIteration} finished in ${(event.durationMs / 1000).toFixed(1)}s.`,
          40
        )
      };

      if (event.exitCode !== 0 || event.context.status === 'blocked') {
        return {
          ...nextState,
          ...pushNotification(nextState, {
            level: 'error',
            title: `${event.context.title} stopped`,
            body: `${event.context.lastError ?? `Provider exited with code ${event.exitCode}.`} ${buildFailureSuggestion(event.context.lastError ?? '', event.context)}`
          })
        };
      }

      return nextState;
    }
    case 'summary':
      return {
        ...state,
        phase: 'done',
        contexts: event.summary.contexts,
        summary: event.summary,
        activeStep: buildRunCompletionStatus(event.summary),
        eventLog: pushLimited(state.eventLog, event.summary.completed ? 'Run finished successfully.' : 'Run finished with pending work.', 40),
        ...pushNotification(state, {
          level: event.summary.completed ? 'success' : 'warning',
          title: event.summary.completed ? 'Execution finished' : 'Execution paused',
          body: buildRunSummaryText(event.summary)
        })
      };
    default:
      return state;
  }
}

export function dashboardReducer(state: DashboardState, action: DashboardAction): DashboardState {
  if (action.type === 'batch') {
    return action.events.reduce((nextState, event) => applyEvent(nextState, event), state);
  }

  if (action.type === 'runtime-error') {
    return {
      ...state,
      phase: 'error',
      activeStep: 'Runtime failed',
      eventLog: pushLimited(state.eventLog, `[error] ${action.message}`, 40),
      ...pushNotification(state, {
        level: 'error',
        title: 'Runtime failed',
        body: `${action.message} ${buildFailureSuggestion(action.message, null)}`
      })
    };
  }

  return applyEvent(state, action);
}

function statusBadge(context: RalphContextSnapshot): { color: 'green' | 'yellow' | 'red' | 'blue'; label: string } {
  if (isContextComplete(context)) {
    return { color: 'green', label: completedEarly(context) ? 'done early' : 'done' };
  }

  if (context.status === 'running') {
    return { color: 'blue', label: 'live' };
  }

  if (context.status === 'blocked' || context.status === 'error') {
    return { color: 'red', label: 'blocked' };
  }

  return { color: 'yellow', label: 'queued' };
}

function isContextComplete(context: RalphContextSnapshot): boolean {
  return context.status === 'complete' || (context.done && context.iterationsRun >= context.iterationsTarget);
}

function contextProgressValue(context: RalphContextSnapshot): number {
  if (isContextComplete(context)) {
    return 100;
  }

  const backlog = context.backlog;
  if (!backlog) {
    return 0;
  }

  if (backlog.totalSteps > 0) {
    return Math.round((backlog.completedSteps / backlog.totalSteps) * 100);
  }

  if (backlog.totalItems > 0) {
    return Math.round((backlog.completedItems / backlog.totalItems) * 100);
  }

  return 0;
}

function projectContextLabel(config: RalphConfig): string {
  return config.projectContextMode === 'contextual' ? 'Contextual' : 'Global';
}

function buildFallbackSummary(config: RalphConfig, contexts: RalphContextSnapshot[]): RalphRunSummary {
  return {
    completed: contexts.every(isContextComplete),
    tool: config.tool,
    schedule: config.schedule,
    maxIterations: config.maxIterations,
    usageTotals: aggregateUsageTotals(contexts.map(context => context.usageTotals)),
    finalBranchName: null,
    contexts
  };
}

function DashboardApp({ config, onExit }: { config: RalphConfig; onExit: (result: DashboardResult) => void }) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(dashboardReducer, initialState);
  const [selectedPane, setSelectedPane] = useState(0);
  const [closedPlanIds, setClosedPlanIds] = useState<Set<string>>(new Set());
  const [doneActionIndex, setDoneActionIndex] = useState(0);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [arcadeOpen, setArcadeOpen] = useState(false);
  const queueRef = useRef<RalphEvent[]>([]);
  const summaryRef = useRef<RalphRunSummary | null>(null);
  const { columns, rows } = useTerminalViewport();
  const frameColumns = Math.max(60, columns - 4);
  const frameRows = Math.max(20, rows - 4);
  const sidebarWidth = Math.max(24, Math.min(34, Math.floor(frameColumns * 0.34)));
  const sidebarLabelWidth = 10;
  const sidebarValueWidth = Math.max(8, sidebarWidth - 15);
  const detailColumnsWidth = Math.max(48, frameColumns - sidebarWidth - 1);
  const checklistPanelWidth = Math.max(36, Math.min(52, Math.floor(detailColumnsWidth * 0.44)));
  const checklistTextWidth = Math.max(16, checklistPanelWidth - 8);
  const signalPanelWidth = Math.max(24, detailColumnsWidth - checklistPanelWidth - 1);
  const signalFeedTextWidth = Math.max(20, signalPanelWidth - 4);

  useEffect(() => {
    const timer = setInterval(() => {
      if (queueRef.current.length === 0) {
        return;
      }

      const batch = queueRef.current.splice(0, queueRef.current.length);
      startTransition(() => {
        dispatch({
          type: 'batch',
          events: batch
        });
      });
    }, 50);

    void runRalphi(config, event => {
      queueRef.current.push(event);
      if (event.type === 'summary') {
        summaryRef.current = event.summary;
      }
    })
      .then(summary => {
        summaryRef.current = summary;
      })
      .catch((error: Error) => {
        dispatch({
          type: 'runtime-error',
          message: error.message
        });
      });

    return () => {
      clearInterval(timer);
    };
  }, [config]);

  const orderedPlans = useMemo(() => orderPlansForQueue(config.plans), [config.plans]);
  const orderedContexts = useMemo(() => orderContextsForQueue(state.contexts, config.plans), [config.plans, state.contexts]);
  const visibleContexts = useMemo(
    () => orderedContexts.filter(context => !closedPlanIds.has(context.planId)),
    [closedPlanIds, orderedContexts]
  );

  useEffect(() => {
    setSelectedPane(current => Math.min(current, visibleContexts.length));
  }, [visibleContexts.length]);

  const activeContext = selectedPane === 0 ? null : visibleContexts[selectedPane - 1] ?? null;
  const completedCount = state.contexts.filter(isContextComplete).length;
  const overallProgress = state.contexts.length === 0 ? 0 : Math.round((completedCount / state.contexts.length) * 100);
  const latestNotification = state.notifications[state.notifications.length - 1] ?? null;
  const tabs = ['OVERVIEW', ...visibleContexts.map(context => truncateEnd(context.title, 16)), 'ARCADE'];
  const selectedOutput = activeContext ? state.outputLogByContext[activeContext.index] ?? [] : [];
  const activeItem = activeContext?.backlog?.items.find(item => item.id === activeContext.activeBacklogItemId) ?? null;
  const resolvedSummary = useMemo(
    () => state.summary ?? buildFallbackSummary(config, state.contexts),
    [config, state.contexts, state.summary]
  );
  const runUsage = useMemo(
    () =>
      resolvedSummary.usageTotals ??
      aggregateUsageTotals(state.contexts.map(context => resolveContextUsageTotals(context))),
    [resolvedSummary, state.contexts]
  );
  const runTokensUsedValue = useMemo(() => formatUsageTokenTotal(runUsage), [runUsage]);
  const runCompletionRows = useMemo(() => {
    const completed = resolvedSummary.contexts.filter(context => isContextComplete(context)).length;
    const commits = resolvedSummary.contexts.filter(context => Boolean(context.commitSha)).length;
    const pending = Math.max(0, resolvedSummary.contexts.length - completed);
    const pauseReason = buildSummaryPauseReason(resolvedSummary);

    return [
      { label: 'PRDs', value: `${completed}/${resolvedSummary.contexts.length} complete` },
      { label: 'Pending', value: pending === 0 ? 'none' : `${pending} need attention` },
      ...(pauseReason ? [{ label: 'Reason', value: pauseReason }] : []),
      {
        label: 'Commits',
        value: pending > 0 ? `${commits} recorded` : `${commits} ready for review`
      },
      ...(resolvedSummary.finalBranchName ? [{ label: 'Final branch', value: resolvedSummary.finalBranchName }] : []),
      ...buildCompletionUsageRows(runUsage)
    ];
  }, [resolvedSummary, runUsage]);
  const activeWorkspaceLabel = activeContext
    ? activeContext.worktreeRemoved
      ? `released · ${displayPath(activeContext.worktreePath ?? activeContext.workspaceDir, config.rootDir)}`
      : displayPath(activeContext.workspaceDir, config.rootDir)
    : 'n/a';
  const latestIteration = activeContext?.iterationHistory[activeContext.iterationHistory.length - 1] ?? null;
  const activeUsage = useMemo(() => resolveContextUsageTotals(activeContext), [activeContext]);
  const activeCommitLabel = activeContext
    ? activeContext.commitSha
      ? activeContext.commitSha.slice(0, 12)
      : activeContext.worktreeRemoved
        ? 'no changes'
        : 'pending'
    : 'n/a';
  const activeIterationLabel = latestIteration
    ? `exit ${latestIteration.exitCode} · ${latestIteration.lineCount} lines · ${(latestIteration.durationMs / 1000).toFixed(1)}s`
    : 'awaiting first iteration';
  const activeTokensUsedValue = useMemo(() => formatUsageTokenTotal(activeUsage), [activeUsage]);
  const activeSpendRows = useMemo(
    () => buildUsageDisplayRows(activeUsage).filter(row => row.label === 'Spend'),
    [activeUsage]
  );
  const activeCompletionRows = useMemo(() => {
    if (!activeContext) {
      return [];
    }

    const pauseReason = buildContextPauseReason(activeContext);
    return [
      { label: 'Stories', value: activeContext.storyProgress },
      { label: 'Backlog', value: activeContext.backlogProgress },
      { label: 'Commit', value: activeCommitLabel },
      ...(pauseReason ? [{ label: 'Reason', value: pauseReason }] : []),
      ...buildCompletionUsageRows(activeUsage)
    ];
  }, [activeCommitLabel, activeContext, activeUsage]);
  const activeTouchedFiles = latestIteration?.touchedFiles ?? [];
  const activeTouchedSummary =
    activeTouchedFiles.length === 0
      ? 'n/a'
      : `${activeTouchedFiles.length} file${activeTouchedFiles.length === 1 ? '' : 's'} · ${activeTouchedFiles
          .slice(0, 3)
          .map(file => file.path)
          .join(', ')}${activeTouchedFiles.length > 3 ? ', ...' : ''}`;
  const activeMcpSummary =
    activeContext?.mcpServers.length
      ? activeContext.mcpServers.map(server => `${server.name}:${server.state}`).join(', ')
      : null;
  const checklistStatus =
    activeContext && isContextComplete(activeContext)
      ? backlogStatusBadge('done')
      : activeItem
        ? backlogStatusBadge(activeItem.status)
        : null;
  const hasPendingWork = Boolean(state.summary && !state.summary.completed) || state.phase === 'error';
  const hasCheckpointedState = state.contexts.length > 0;
  const canRetryActiveContext = Boolean(
    activeContext?.lastFailure?.retryable && activeContext.lastFailure.retryCount === 0
  );
  const doneActions = hasPendingWork
    ? [
        ...(canRetryActiveContext
          ? [
              {
                id: 'retry-last-iteration',
                label: 'Retry failed iteration',
                description: 'Replay the last failed iteration once using the saved checkpoint.'
              }
            ]
          : []),
        {
          id: 'resume-session',
          label: hasCheckpointedState ? 'Resume from checkpoint' : 'Retry launch',
          description: hasCheckpointedState
            ? 'Continue the unfinished run from the last checkpoint saved in .ralphi/state.'
            : 'Rerun the same execution with the current launch config.'
        },
        {
          id: 'restart-session',
          label: 'Restart from scratch',
          description: 'Clear the saved state and rerun this exact execution from the beginning.'
        },
        {
          id: 'discard-session',
          label: 'Discard saved state',
          description: 'Delete the unfinished execution state and return to the wizard.'
        },
        {
          id: 'finish',
          label: 'Return home',
          description: 'Leave the runtime and reopen the initial wizard without changing the saved checkpoints.'
        }
      ]
    : activeContext && state.phase === 'done' && isContextComplete(activeContext)
      ? [
          {
            id: 'create-pr',
            label: 'Create git PR',
            description: 'Push the agent branch and create a GitHub pull request for this finished context.'
          },
          {
            id: 'finish',
            label: state.contexts.length <= 1 ? 'Finish and return home' : 'Finish and close this agent',
            description:
              state.contexts.length <= 1
                ? 'Leave the runtime and reopen the initial Ralphi wizard.'
                : 'Close only this agent dashboard and keep the remaining agents visible.'
          }
        ]
      : [];
  const overviewSecondaryPanelWidth = Math.max(34, Math.min(44, Math.floor(detailColumnsWidth * 0.36)));
  const overviewSecondaryTextWidth = Math.max(18, overviewSecondaryPanelWidth - 4);
  const overviewQueuePanelWidth = Math.max(28, detailColumnsWidth - overviewSecondaryPanelWidth - 1);
  const overviewQueueTitleWidth = Math.max(12, overviewQueuePanelWidth - 18);
  const overviewQueueDetailWidth = Math.max(10, Math.min(18, overviewQueuePanelWidth - overviewQueueTitleWidth - 4));
  const dashboardChromeHeight = 8;
  const agentSummaryHeight = 17;
  const detailPanelChromeHeight = 4;
  const navigationHeight = 7;
  const layoutSpacingHeight = state.phase === 'done' || state.phase === 'error' ? 3 : 2;
  const notificationHeight = latestNotification ? 5 : 0;
  const completionSummaryRowCount = Math.max(runCompletionRows.length, activeCompletionRows.length, 3);
  const detailValueWidth = Math.max(18, detailColumnsWidth - 18);
  const completionValueWidth = Math.max(18, detailColumnsWidth - 18);
  const completionTextWidth = Math.max(24, detailColumnsWidth - 8);
  const completionHeight =
    state.phase === 'done' || state.phase === 'error'
      ? Math.max(11, Math.min(22, doneActions.length * 3 + completionSummaryRowCount + 5))
      : 0;
  const overviewSecondaryHeight = Math.max(8, Math.min(12, Math.floor(frameRows * 0.24)));
  const checklistBadgeHeight = checklistStatus ? 2 : 0;
  const detailPanelHeight = Math.max(
    state.phase === 'done' || state.phase === 'error' ? 11 : 12,
    frameRows - dashboardChromeHeight - agentSummaryHeight - navigationHeight - notificationHeight - completionHeight - layoutSpacingHeight
  );
  const overviewLogLineLimit = Math.max(3, overviewSecondaryHeight - detailPanelChromeHeight - 1);
  const overviewQueueLineLimit = Math.max(2, overviewSecondaryHeight - detailPanelChromeHeight - 1);
  const detailLineLimit = Math.max(
    state.phase === 'done' || state.phase === 'error' ? 2 : 3,
    detailPanelHeight - detailPanelChromeHeight - checklistBadgeHeight - 1
  );
  const eventLogLines = useMemo(
    () => buildWrappedTextLines(state.eventLog, overviewSecondaryTextWidth, overviewLogLineLimit),
    [overviewLogLineLimit, overviewSecondaryTextWidth, state.eventLog]
  );
  const signalFeedLines = useMemo(
    () => buildTailDisplayLines(selectedOutput, signalFeedTextWidth, detailLineLimit),
    [detailLineLimit, selectedOutput, signalFeedTextWidth]
  );
  const checklistDisplay = useMemo(
    () => buildChecklistDisplayLines(activeItem?.steps ?? [], checklistTextWidth, detailLineLimit),
    [activeItem?.steps, checklistTextWidth, detailLineLimit]
  );

  const exitDashboard = (nextAction: DashboardResult['nextAction']): void => {
    onExit({
      summary: summaryRef.current ?? buildFallbackSummary(config, state.contexts),
      nextAction
    });
    exit();
  };

  const handleFinish = (): void => {
    if (!activeContext) {
      exitDashboard('exit');
      return;
    }

    if (state.contexts.length <= 1) {
      exitDashboard('restart-wizard');
      return;
    }

    if (visibleContexts.length <= 1) {
      exitDashboard('exit');
      return;
    }

    setClosedPlanIds(current => {
      const next = new Set(current);
      next.add(activeContext.planId);
      return next;
    });
    setSelectedPane(0);
    setActionMessage(`Closed ${activeContext.title}.`);
    setActionError(null);
  };

  const handleReturnHome = (): void => {
    exitDashboard('restart-wizard');
  };

  const handleCreatePullRequest = async (): Promise<void> => {
    if (!activeContext) {
      return;
    }

    if (!state.gitValidation?.repository) {
      setActionError('PR creation requires a Git repository with a reachable remote.');
      return;
    }

    if (!activeContext.branchName) {
      setActionError('This context does not have an assigned branch.');
      return;
    }

    setActionBusy(`Creating PR for ${activeContext.title}...`);
    setActionError(null);
    setActionMessage(null);
    try {
      const remoteName = state.gitValidation.defaultRemote?.split('/')[0] || 'origin';
      const baseBranch = state.gitValidation.defaultBranch || activeContext.baseRef || 'main';
      const url = await createGitPullRequest({
        repoDir: state.gitValidation.rootDir,
        branchName: activeContext.branchName,
        baseBranch,
        remoteName,
        title: `Ralphi: ${activeContext.title}`,
        body: [
          'Created by Ralphi.',
          '',
          `Source PRD: ${displayPath(activeContext.sourcePrd, config.rootDir)}`,
          `Iterations: ${formatContextIterations(activeContext)}`,
          `Stories: ${activeContext.storyProgress}`,
          `Backlog: ${activeContext.backlogProgress}`,
          `Log path: ${activeContext.lastLogPath ? displayPath(activeContext.lastLogPath, config.rootDir) : 'n/a'}`
        ].join('\n')
      });
      setActionMessage(url);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to create the pull request.');
    } finally {
      setActionBusy(null);
    }
  };

  const handleRetryLastIteration = async (): Promise<void> => {
    if (!activeContext) {
      return;
    }

    setActionBusy(`Retrying ${activeContext.title}...`);
    setActionError(null);
    setActionMessage(null);
    try {
      const checkpoint = await prepareContextRetry(activeContext.runDir);
      if (!checkpoint) {
        throw new Error('A single retry is not available for this failure anymore.');
      }

      exitDashboard('resume-session');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to prepare the retry.');
    } finally {
      setActionBusy(null);
    }
  };

  useInput((input, key) => {
    if (input === 'g' || input === 'G') {
      setArcadeOpen(current => !current);
      return;
    }

    if (arcadeOpen) {
      return;
    }

    const maxPane = visibleContexts.length;

    if (key.leftArrow) {
      setSelectedPane(current => Math.max(0, current - 1));
      return;
    }

    if (key.rightArrow) {
      setSelectedPane(current => Math.min(maxPane, current + 1));
      return;
    }

    if (state.phase === 'done' || state.phase === 'error') {
      if (actionBusy) {
        return;
      }

      if (key.upArrow && doneActions.length > 0) {
        setDoneActionIndex(current => Math.max(0, current - 1));
        return;
      }

      if (key.downArrow && doneActions.length > 0) {
        setDoneActionIndex(current => Math.min(doneActions.length - 1, current + 1));
        return;
      }

      if (input === 'q' || input === 'Q' || key.escape) {
        exitDashboard('exit');
        return;
      }

      if (key.return) {
        if (doneActions.length === 0) {
          exitDashboard('exit');
          return;
        }

        const action = doneActions[doneActionIndex];
        if (action?.id === 'create-pr') {
          void handleCreatePullRequest();
        } else if (action?.id === 'retry-last-iteration') {
          void handleRetryLastIteration();
        } else if (action?.id === 'resume-session') {
          exitDashboard('resume-session');
        } else if (action?.id === 'restart-session') {
          exitDashboard('restart-session');
        } else if (action?.id === 'discard-session') {
          exitDashboard('discard-session');
        } else if (action?.id === 'finish' && hasPendingWork) {
          handleReturnHome();
        } else {
          handleFinish();
        }
      }
      return;
    }

    if (input === 'q' || input === 'Q') {
      dispatch({
        type: 'boot-log',
        level: 'info',
        message: 'Use Ctrl+C if you need to interrupt the live run.'
      });
    }
  });

  const sidebar = useMemo(
    () => (
      <Box width={sidebarWidth} flexDirection="column" marginRight={1} flexShrink={0}>
        <SectionPanel width={sidebarWidth}>
          <AsciiLogo />
          <Box marginTop={1}>
            <LabelValue label="Context" value={projectContextLabel(config)} labelWidth={sidebarLabelWidth} valueWidth={sidebarValueWidth} />
          </Box>
          <LabelValue label="Provider" value={config.tool} labelWidth={sidebarLabelWidth} valueWidth={sidebarValueWidth} />
          <LabelValue
            label="Schedule"
            value={pickScheduleLabel(config.schedule)}
            labelWidth={sidebarLabelWidth}
            valueWidth={sidebarValueWidth}
          />
          <LabelValue
            label="Workspace"
            value={config.workspaceStrategy}
            labelWidth={sidebarLabelWidth}
            valueWidth={sidebarValueWidth}
          />
          <LabelValue
            label="PRDs"
            value={String(visibleContexts.length || state.contexts.length || config.plans.length)}
            labelWidth={sidebarLabelWidth}
            valueWidth={sidebarValueWidth}
          />
          <LabelValue
            label="Completed"
            value={`${completedCount}/${state.contexts.length || config.plans.length}`}
            labelWidth={sidebarLabelWidth}
            valueWidth={sidebarValueWidth}
          />
        </SectionPanel>
        <Box marginTop={1} flexGrow={1} flexShrink={1}>
          <SectionPanel title="Queue" subtitle={`${completedCount}/${state.contexts.length || config.plans.length}`} width={sidebarWidth} flexGrow={1}>
            {visibleContexts.length === 0
              ? (state.contexts.length === 0 ? orderedPlans : orderedContexts)
                  .filter(contextOrPlan => !closedPlanIds.has('planId' in contextOrPlan ? contextOrPlan.planId : contextOrPlan.id))
                  .map((contextOrPlan, index) => {
                    const isContext = 'planId' in contextOrPlan;
                    const label = isContext ? contextOrPlan.title : contextOrPlan.title;
                    const selected = selectedPane === index + 1;
                    return (
                      <Box key={isContext ? contextOrPlan.planId : contextOrPlan.id} justifyContent="space-between">
                        <Text color={selected ? palette.accent : palette.text}>{truncateMiddle(label, 18)}</Text>
                        <Badge color={isContext ? statusBadge(contextOrPlan).color : 'yellow'}>
                          {isContext ? statusBadge(contextOrPlan).label : 'queued'}
                        </Badge>
                      </Box>
                    );
                  })
              : visibleContexts.map((context, index) => {
                  const status = statusBadge(context);
                  return (
                    <Box key={context.planId} justifyContent="space-between">
                      <Text color={selectedPane === index + 1 ? palette.accent : palette.text}>{truncateMiddle(context.title, 18)}</Text>
                      <Badge color={status.color}>{status.label}</Badge>
                    </Box>
                  );
                })}
          </SectionPanel>
        </Box>
      </Box>
    ),
    [
      closedPlanIds,
      completedCount,
      config,
      orderedContexts,
      orderedPlans,
      selectedPane,
      sidebarLabelWidth,
      sidebarValueWidth,
      sidebarWidth,
      visibleContexts
    ]
  );

  return (
    <ThemeProvider theme={systemTheme}>
      <WindowFrame
        footerLeft={
          state.phase === 'done' || state.phase === 'error'
            ? `${projectContextLabel(config)} · ${state.activeStep}`
            : `${projectContextLabel(config)} · ${state.waveLabel} // ${state.activeStep}`
        }
        footerRight={arcadeOpen ? 'Arcade active' : actionBusy ? 'Working' : state.phase === 'done' ? 'Summary ready' : state.phase === 'error' ? 'Runtime error' : 'Runtime active'}
      >
        <SystemTabs
          tabs={tabs.length > 0 ? tabs : ['OVERVIEW']}
          activeIndex={arcadeOpen ? Math.max(tabs.length - 1, 0) : Math.min(selectedPane, Math.max(tabs.length - 2, 0))}
        />
        <Box>
          {arcadeOpen ? null : sidebar}
          <Box flexGrow={1} flexDirection="column">
            {latestNotification ? (
              <Box marginBottom={1}>
                <Box borderStyle="round" borderColor={notificationColor(latestNotification.level)} paddingX={1} flexDirection="column">
                  <Text color={notificationColor(latestNotification.level)}>
                    {`${latestNotification.title}${state.notifications.length > 1 ? ` (+${state.notifications.length - 1})` : ''}`}
                  </Text>
                  <Text color={palette.dim} wrap="truncate-end">
                    {latestNotification.body}
                  </Text>
                </Box>
              </Box>
            ) : null}
            {arcadeOpen ? (
              <ArcadeCabinet maxWidth={columns - 6} maxHeight={rows - 12} onClose={() => setArcadeOpen(false)} />
            ) : selectedPane === 0 ? (
              <>
                <SectionPanel
                  title="Overview"
                  subtitle={state.phase === 'done' ? 'DONE' : state.phase === 'error' ? 'ERROR' : 'BOOT'}
                  flexGrow={0}
                >
                  <Box justifyContent="space-between">
                    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                      <Text color={palette.text}>Project orchestration</Text>
                      <Text color={palette.dim} wrap="truncate-middle">
                        {state.projectConfigPath ? displayPath(state.projectConfigPath, config.rootDir) : '.ralphi.json'}
                      </Text>
                    </Box>
                    <Box>
                      {state.phase === 'done' ? (
                        <Badge color={state.summary?.completed ? 'green' : 'yellow'}>{state.summary?.completed ? 'complete' : 'pending'}</Badge>
                      ) : state.phase === 'error' ? (
                        <Badge color="red">error</Badge>
                      ) : (
                        <Spinner label={state.activeStep} />
                      )}
                    </Box>
                  </Box>
                  <Box marginTop={1}>
                    <ProgressBar value={overallProgress} />
                  </Box>
                  <Box marginTop={1} flexDirection="column">
                    <LabelValue label="Wave" value={state.waveLabel} valueWidth={detailValueWidth} />
                    <LabelValue label="Context" value={projectContextLabel(config)} valueWidth={detailValueWidth} />
                    <LabelValue label="Project config" value={state.projectConfigPath ? displayPath(state.projectConfigPath, config.rootDir) : 'pending'} valueWidth={detailValueWidth} />
                    <LabelValue label="Missing skills" value={String(state.missingSkillCount)} valueWidth={detailValueWidth} />
                    <LabelValue
                      label="Git"
                      value={
                        state.gitValidation?.repository
                          ? `${state.gitValidation.currentBranch ?? 'detached'}${state.gitValidation.clean ? '' : ' · dirty'}`
                          : 'not detected'
                      }
                      valueWidth={detailValueWidth}
                    />
                    <LabelValue
                      label="Worktrees"
                      value={state.gitValidation?.repository ? displayPath(state.gitValidation.worktreeRoot, config.rootDir) : 'disabled'}
                      valueWidth={detailValueWidth}
                    />
                    <LabelValue
                      label="Doctor"
                      value={
                        state.doctorReport
                          ? `${state.doctorReport.counts.ok}/${state.doctorReport.counts.warning}/${state.doctorReport.counts.blocking}`
                          : 'pending'
                      }
                      valueWidth={detailValueWidth}
                    />
                    <LabelValue label="Tokens Used" value={runTokensUsedValue ?? 'pending'} valueWidth={detailValueWidth} />
                  </Box>
                </SectionPanel>

                <Box marginTop={1} flexGrow={1} flexShrink={1} alignItems="stretch">
                  <SectionPanel
                    title="Activity log"
                    subtitle="EVENTS"
                    width={overviewSecondaryPanelWidth}
                    flexGrow={1}
                  >
                    {eventLogLines.length === 0 ? (
                      <Text color={palette.dim}>Waiting for lifecycle events.</Text>
                    ) : (
                      eventLogLines.map(line => (
                        <Text key={line.key} color={palette.text} wrap="truncate-end">
                          {line.text || ' '}
                        </Text>
                      ))
                    )}
                  </SectionPanel>
                  <Box marginLeft={1} flexGrow={1} flexShrink={1}>
                    <SectionPanel title="Agent overview" subtitle="QUEUE" width={overviewQueuePanelWidth} flexGrow={1}>
                      {visibleContexts.length === 0 ? (
                        <Text color={palette.dim}>Contexts will appear after bootstrapping finishes.</Text>
                      ) : (
                        visibleContexts.slice(-overviewQueueLineLimit).map(context => {
                          const tokensUsedLabel = buildTokensUsedLabel(resolveContextUsageTotals(context));
                          const detailLabel = `${context.backlogProgress}${tokensUsedLabel ? ` (${tokensUsedLabel})` : ''}`;

                          return (
                            <Box key={context.planId} justifyContent="space-between">
                              <Text color={palette.text} wrap="truncate-middle">
                                {truncateMiddle(context.title, overviewQueueTitleWidth)}
                              </Text>
                              <Text color={palette.dim} wrap="truncate-end">
                                {truncateEnd(detailLabel, overviewQueueDetailWidth)}
                              </Text>
                            </Box>
                          );
                        })
                      )}
                    </SectionPanel>
                  </Box>
                </Box>

                {state.phase === 'done' || state.phase === 'error' ? (
                  <Box marginTop={1} flexShrink={0}>
                    <SectionPanel title="Completion" subtitle="NEXT" height={completionHeight} flexGrow={1}>
                      <Box flexDirection="column" marginBottom={1}>
                        <Text color={palette.accent}>Run summary</Text>
                        {runCompletionRows.map(row => (
                          <LabelValue
                            key={`completion-overview-${row.label}`}
                            label={row.label}
                            value={row.value}
                            valueWidth={completionValueWidth}
                          />
                        ))}
                      </Box>
                      {doneActions.length === 0 ? (
                        <Text color={palette.dim}>Open an agent pane to review the finished context, or press q to leave the runtime.</Text>
                      ) : (
                        <>
                          <Text color={palette.accent}>Next actions</Text>
                          <Box marginTop={1} flexDirection="column">
                            {doneActions.map((action, index) => (
                              <Box key={action.id} flexDirection="column" marginBottom={1}>
                                <Text color={index === doneActionIndex ? palette.accent : palette.text} wrap="truncate-end">
                                  {`${index === doneActionIndex ? '> ' : '  '}${truncateEnd(action.label, completionTextWidth)}`}
                                </Text>
                                <Box marginLeft={3}>
                                  <Text color={palette.dim} wrap="truncate-end">
                                    {truncateEnd(action.description, completionTextWidth - 3)}
                                  </Text>
                                </Box>
                              </Box>
                            ))}
                          </Box>
                        </>
                      )}
                      {actionBusy ? <Text color={palette.accent}>{actionBusy}</Text> : null}
                      {actionMessage ? <Text color={palette.green}>{truncateEnd(actionMessage, completionTextWidth)}</Text> : null}
                      {actionError ? <Text color={palette.danger}>{truncateEnd(actionError, completionTextWidth)}</Text> : null}
                    </SectionPanel>
                  </Box>
                ) : null}
              </>
            ) : activeContext ? (
              <>
                <SectionPanel
                  title={truncateMiddle(activeContext.title, 36)}
                  subtitle={statusBadge(activeContext).label.toUpperCase()}
                  flexGrow={0}
                >
                  <Box justifyContent="space-between">
                    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                      <Text color={palette.text} wrap="truncate-middle">
                        {displayPath(activeContext.sourcePrd, config.rootDir)}
                      </Text>
                      <Text color={palette.dim} wrap="truncate-end">
                        {activeContext.branchName ?? 'shared workspace'}
                      </Text>
                    </Box>
                    <Box>
                      {state.phase === 'done' && activeContext.done ? (
                        <Badge color="green">done</Badge>
                      ) : activeContext.status === 'running' ? (
                        <Spinner label={activeContext.lastStep} />
                      ) : (
                        <Badge color={statusBadge(activeContext).color}>{statusBadge(activeContext).label}</Badge>
                      )}
                    </Box>
                  </Box>
                  <Box marginTop={1}>
                    <ProgressBar value={contextProgressValue(activeContext)} />
                  </Box>
                  <Box marginTop={1} flexDirection="column">
                    <LabelValue label="Workspace" value={activeWorkspaceLabel} valueWidth={detailValueWidth} />
                    <LabelValue label="Base ref" value={activeContext.baseRef ?? 'HEAD'} valueWidth={detailValueWidth} />
                    <LabelValue label="Iterations" value={formatContextIterations(activeContext)} valueWidth={detailValueWidth} />
                    <LabelValue label="Last run" value={activeIterationLabel} valueWidth={detailValueWidth} />
                    <LabelValue label="Stories" value={activeContext.storyProgress} valueWidth={detailValueWidth} />
                    <LabelValue label="Backlog" value={activeContext.backlogProgress} valueWidth={detailValueWidth} />
                    <LabelValue label="Files" value={activeTouchedSummary} valueWidth={detailValueWidth} />
                    <LabelValue label="Commit" value={activeCommitLabel} valueWidth={detailValueWidth} />
                    <LabelValue label="Log path" value={activeContext.lastLogPath ? displayPath(activeContext.lastLogPath, config.rootDir) : 'awaiting output'} valueWidth={detailValueWidth} />
                    <LabelValue
                      label="Prompt"
                      value={activeContext.lastPromptPreviewPath ? displayPath(activeContext.lastPromptPreviewPath, config.rootDir) : 'awaiting prompt'}
                      valueWidth={detailValueWidth}
                    />
                    <LabelValue label="Tokens Used" value={activeTokensUsedValue ?? 'pending'} valueWidth={detailValueWidth} />
                    {activeContext.lastFailure ? (
                      <LabelValue
                        label="Failure"
                        value={`${failureCategoryLabel(activeContext.lastFailure.category)}${activeContext.lastFailure.retryable ? ' · retryable' : ''}`}
                        valueWidth={detailValueWidth}
                      />
                    ) : null}
                    {activeMcpSummary ? <LabelValue label="MCP" value={activeMcpSummary} valueWidth={detailValueWidth} /> : null}
                    {activeSpendRows.map(row => (
                      <LabelValue key={`context-usage-${row.label}`} label={row.label} value={row.value} valueWidth={detailValueWidth} />
                    ))}
                  </Box>
                  {activeContext.lastFailure ? (
                    <Box marginTop={1} flexDirection="column">
                      <Text color={palette.danger}>{activeContext.lastFailure.summary}</Text>
                      <Text color={palette.dim}>{activeContext.lastFailure.recoveryHint}</Text>
                    </Box>
                  ) : null}
                </SectionPanel>

                <Box marginTop={1} flexGrow={1} flexShrink={1} alignItems="stretch">
                  <SectionPanel
                    title={activeItem ? activeItem.title : 'Current backlog item'}
                    subtitle="CHECKLIST"
                    width={checklistPanelWidth}
                    flexGrow={1}
                  >
                    {checklistStatus ? (
                      <Box marginBottom={1}>
                        <Badge color={checklistStatus.color}>{checklistStatus.label}</Badge>
                      </Box>
                    ) : null}
                    {activeItem ? (
                      <>
                        {checklistDisplay.lines.map(line => (
                          <Box key={line.key}>
                            <Text color={line.markerColor}>
                              {line.marker}
                            </Text>
                            <Text color={palette.text} wrap="truncate-end">
                              {line.text || ' '}
                            </Text>
                          </Box>
                        ))}
                        {checklistDisplay.hiddenSteps > 0 ? (
                          <HintLine>{`... and ${checklistDisplay.hiddenSteps} more steps`}</HintLine>
                        ) : null}
                      </>
                    ) : (
                      <Text color={palette.dim}>Ralphi is waiting for the first backlog signal.</Text>
                    )}
                  </SectionPanel>
                  <Box marginLeft={1} flexGrow={1} flexShrink={1}>
                    <SectionPanel
                      title={config.verbose ? 'Raw stream' : 'Signal feed'}
                      subtitle={config.verbose ? 'VERBOSE' : 'TAIL'}
                      width={signalPanelWidth}
                      flexGrow={1}
                    >
                      {signalFeedLines.length === 0 ? (
                        <Text color={palette.dim}>{config.verbose ? 'Provider output will stream here.' : 'Live provider hints will appear here.'}</Text>
                      ) : (
                        signalFeedLines.map(line => (
                          <Text key={line.key} color={signalToneColor(line.tone)} wrap="truncate-end">
                            {line.text || ' '}
                          </Text>
                        ))
                      )}
                    </SectionPanel>
                  </Box>
                </Box>

                {state.phase === 'done' || state.phase === 'error' ? (
                  <Box marginTop={1} flexShrink={0}>
                    <SectionPanel title="Completion" subtitle="NEXT" height={completionHeight} flexGrow={1}>
                      <Box flexDirection="column" marginBottom={1}>
                        <Text color={palette.accent}>Context summary</Text>
                        {activeCompletionRows.map(row => (
                          <LabelValue
                            key={`completion-context-${row.label}`}
                            label={row.label}
                            value={row.value}
                            valueWidth={completionValueWidth}
                          />
                        ))}
                      </Box>
                      <Text color={palette.accent}>Next actions</Text>
                      <Box marginTop={1} flexDirection="column">
                        {doneActions.map((action, index) => (
                          <Box key={action.id} flexDirection="column" marginBottom={1}>
                            <Text color={index === doneActionIndex ? palette.accent : palette.text} wrap="truncate-end">
                              {`${index === doneActionIndex ? '> ' : '  '}${truncateEnd(action.label, completionTextWidth)}`}
                            </Text>
                            <Box marginLeft={3}>
                              <Text color={palette.dim} wrap="truncate-end">
                                {truncateEnd(action.description, completionTextWidth - 3)}
                              </Text>
                            </Box>
                          </Box>
                        ))}
                      </Box>
                      {actionBusy ? <Text color={palette.accent}>{actionBusy}</Text> : null}
                      {actionMessage ? <Text color={palette.green}>{truncateEnd(actionMessage, completionTextWidth)}</Text> : null}
                      {actionError ? <Text color={palette.danger}>{truncateEnd(actionError, completionTextWidth)}</Text> : null}
                    </SectionPanel>
                  </Box>
                ) : null}
              </>
            ) : (
              <SectionPanel title="Overview" subtitle="DONE" flexGrow={1}>
                <Text color={palette.dim}>All agent dashboards were closed. Press q or Enter to leave the runtime.</Text>
              </SectionPanel>
            )}

            <Box marginTop={1} flexShrink={0}>
              <SectionPanel title="Navigation" subtitle="CTRL" flexGrow={1}>
                <HintLine>Use ← → to switch between the overview and agent dashboards.</HintLine>
                <HintLine>Press G to open the ARCADE menu while Ralphi keeps working.</HintLine>
                {state.phase === 'done' || state.phase === 'error' ? (
                  <>
                    <HintLine>Use ↑ ↓ to choose the next action for this run.</HintLine>
                    <HintLine>Press Enter to run the selected action or q to leave the runtime.</HintLine>
                  </>
                ) : (
                  <>
                    <HintLine>Press q for a reminder while the run is active.</HintLine>
                    <HintLine>Wait for the summary before creating PRs or closing agent dashboards.</HintLine>
                  </>
                )}
              </SectionPanel>
            </Box>
          </Box>
        </Box>
      </WindowFrame>
    </ThemeProvider>
  );
}

export async function runDashboard(config: RalphConfig): Promise<DashboardResult> {
  return new Promise<DashboardResult>(resolve => {
    render(<DashboardApp config={config} onExit={resolve} />);
  });
}
