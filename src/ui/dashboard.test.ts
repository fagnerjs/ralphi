import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildContextPauseReason,
  buildCompletionUsageRows,
  buildSummaryPauseReason,
  buildRunSummaryText,
  classifySignalTone,
  completedEarly,
  createInitialDashboardState,
  dashboardReducer,
  formatContextIterations,
  orderContextsForQueue,
  resolveActiveBacklogItem,
  resolveChecklistStatus,
  resolveContextUsageTotals
} from './dashboard.js';
import { createTempProject, makeConfig, makeContextSnapshot, makePlan, makeRunSummary, makeUsageTotals } from '../test-support.js';

test('dashboardReducer adds a start notification when execution is prepared', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config);
    const next = dashboardReducer(createInitialDashboardState(), {
      type: 'prepared',
      contexts: [context]
    });

    assert.equal(next.phase, 'running');
    assert.equal(next.contexts.length, 1);
    assert.equal(next.notifications.length, 1);
    assert.equal(next.notifications[0]?.title, 'Execution started');
    assert.match(next.notifications[0]?.body ?? '', /1 PRD workstream prepared/);
  } finally {
    await fixture.cleanup();
  }
});

test('orderContextsForQueue follows the configured execution order', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const foundationPrd = path.join(fixture.rootDir, 'docs', 'prds', 'foundation.md');
    const releasePrd = path.join(fixture.rootDir, 'docs', 'prds', 'release.md');
    const polishPrd = path.join(fixture.rootDir, 'docs', 'prds', 'polish.md');
    const config = makeConfig(fixture.rootDir, {
      plans: [
        makePlan(releasePrd, {
          id: 'release',
          title: 'release',
          dependsOn: 'foundation'
        }),
        makePlan(foundationPrd, {
          id: 'foundation',
          title: 'foundation'
        }),
        makePlan(polishPrd, {
          id: 'polish',
          title: 'polish'
        })
      ]
    });
    const ordered = orderContextsForQueue(
      [
        makeContextSnapshot(config, {
          index: 0,
          planId: 'release',
          sourcePrd: releasePrd,
          title: 'release',
          dependsOnPlanId: 'foundation'
        }),
        makeContextSnapshot(config, {
          index: 1,
          planId: 'foundation',
          sourcePrd: foundationPrd,
          title: 'foundation'
        }),
        makeContextSnapshot(config, {
          index: 2,
          planId: 'polish',
          sourcePrd: polishPrd,
          title: 'polish'
        })
      ],
      config.plans
    );

    assert.deepEqual(
      ordered.map(context => context.planId),
      ['foundation', 'release', 'polish']
    );
  } finally {
    await fixture.cleanup();
  }
});

test('formatContextIterations explains when a PRD completed before the configured limit', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config, {
      done: true,
      status: 'complete',
      iterationsRun: 2,
      iterationsTarget: 3
    });

    assert.equal(completedEarly(context), true);
    assert.equal(formatContextIterations(context), '2/3 used · completed early');
  } finally {
    await fixture.cleanup();
  }
});

test('completedEarly preserves done PRDs after resuming a queued run', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config, {
      done: true,
      status: 'queued',
      iterationsRun: 2,
      iterationsTarget: 4
    });

    assert.equal(completedEarly(context), true);
    assert.equal(formatContextIterations(context), '2/4 used · completed early');
    assert.equal(buildContextPauseReason(context), null);
  } finally {
    await fixture.cleanup();
  }
});

test('resolveActiveBacklogItem falls back to the last completed item for done contexts without an active pointer', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config, {
      done: true,
      status: 'complete',
      activeBacklogItemId: null,
      activeBacklogStepId: null,
      backlog: {
        items: [
          {
            id: 'BT-001',
            storyId: 'US-001',
            title: 'First item',
            description: 'Done first.',
            status: 'done',
            notes: '',
            steps: [
              {
                id: 'ST-001',
                title: 'Step one',
                status: 'done'
              }
            ],
            updatedAt: '2026-03-07T00:00:00.000Z',
            source: 'prd',
            manualTitle: null,
            manualDescription: null
          },
          {
            id: 'BT-002',
            storyId: 'US-002',
            title: 'Last completed item',
            description: 'Done second.',
            status: 'done',
            notes: '',
            steps: [
              {
                id: 'ST-002',
                title: 'Step two',
                status: 'done'
              }
            ],
            updatedAt: '2026-03-07T00:00:00.000Z',
            source: 'prd',
            manualTitle: null,
            manualDescription: null
          }
        ],
        totalItems: 2,
        completedItems: 2,
        totalSteps: 2,
        completedSteps: 2,
        activeItemId: null,
        activeStepId: null
      }
    });

    assert.equal(resolveActiveBacklogItem(context)?.id, 'BT-002');
  } finally {
    await fixture.cleanup();
  }
});

test('resolveChecklistStatus keeps exhausted queued contexts out of the live state', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config, {
      done: false,
      status: 'queued',
      iterationsRun: 3,
      iterationsTarget: 3,
      backlog: {
        items: [
          {
            id: 'BT-001',
            storyId: 'US-001',
            title: 'Pending item',
            description: 'Still missing one step.',
            status: 'in_progress',
            notes: '',
            steps: [
              {
                id: 'ST-001',
                title: 'Last step',
                status: 'in_progress'
              }
            ],
            updatedAt: '2026-03-07T00:00:00.000Z',
            source: 'prd',
            manualTitle: null,
            manualDescription: null
          }
        ],
        totalItems: 1,
        completedItems: 0,
        totalSteps: 1,
        completedSteps: 0,
        activeItemId: 'BT-001',
        activeStepId: 'ST-001'
      },
      activeBacklogItemId: 'BT-001',
      activeBacklogStepId: 'ST-001'
    });

    const activeItem = resolveActiveBacklogItem(context);
    assert.equal(activeItem?.status, 'in_progress');
    assert.deepEqual(resolveChecklistStatus(context, activeItem), {
      color: 'yellow',
      label: 'queued'
    });
  } finally {
    await fixture.cleanup();
  }
});

test('dashboardReducer turns error boot logs into actionable notifications', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config, {
      lastLogPath: path.join(fixture.rootDir, '.ralphi', 'state', 'sample', 'logs', 'latest.log'),
      lastFailure: {
        category: 'provider_runtime',
        retryable: true,
        retryCount: 0,
        summary: 'Provider failed',
        recoveryHint: 'Reinstall the provider and resume.',
        rawLogPath: null
      }
    });
    const seeded = {
      ...createInitialDashboardState(),
      contexts: [context]
    };
    const next = dashboardReducer(seeded, {
      type: 'boot-log',
      level: 'error',
      message: 'Provider failed to start.',
      contextIndex: 0
    });

    assert.equal(next.notifications.length, 1);
    assert.equal(next.notifications[0]?.level, 'error');
    assert.match(next.notifications[0]?.body ?? '', /Reinstall the provider and resume\./);
  } finally {
    await fixture.cleanup();
  }
});

test('dashboardReducer applies usage-update to the active context in real time', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config, {
      usageTotals: null,
      status: 'running'
    });
    const usageTotals = makeUsageTotals({
      totalTokens: 2450,
      totalCostUsd: 0.91
    });
    const seeded = {
      ...createInitialDashboardState(),
      phase: 'running' as const,
      contexts: [context],
      activeContextIndex: 0
    };

    const next = dashboardReducer(seeded, {
      type: 'usage-update',
      contextIndex: 0,
      usageTotals
    });

    assert.deepEqual(next.contexts[0]?.usageTotals, usageTotals);
    assert.equal(next.activeContextIndex, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('dashboardReducer summarizes completion with success notifications and usage totals', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config, {
      done: true,
      status: 'complete',
      commitSha: '1234567890abcdef',
      usageTotals: makeUsageTotals()
    });
    const summary = makeRunSummary([context], {
      completed: true,
      usageTotals: makeUsageTotals(),
      contexts: [context]
    });

    const next = dashboardReducer(createInitialDashboardState(), {
      type: 'summary',
      summary
    });

    assert.equal(next.phase, 'done');
    assert.equal(next.notifications[0]?.title, 'Execution finished');
    assert.match(next.notifications[0]?.body ?? '', /1\/1 PRDs complete/);
    assert.match(next.notifications[0]?.body ?? '', /1,620 tokens used/);
    assert.match(next.notifications[0]?.body ?? '', /\$0\.42 spent/);
    assert.match(buildRunSummaryText(summary), /1 commit ready for review/);
    assert.match(buildRunSummaryText(summary), /\$0\.42 spent/);
  } finally {
    await fixture.cleanup();
  }
});

test('dashboardReducer uses a pending-work summary label when the run stops before completion', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config, {
      done: false,
      status: 'queued',
      iterationsRun: 1,
      iterationsTarget: 1,
      storyProgress: '1/4 stories complete',
      backlogProgress: '1/4 tasks · 5/20 steps'
    });
    const summary = makeRunSummary([context], {
      completed: false,
      usageTotals: null,
      contexts: [context]
    });

    const next = dashboardReducer(createInitialDashboardState(), {
      type: 'summary',
      summary
    });

    assert.equal(next.phase, 'done');
    assert.equal(next.activeStep, 'All configured passes used');
    assert.equal(next.notifications[0]?.title, 'Execution paused');
    assert.match(next.notifications[0]?.body ?? '', /Reason: All configured passes used; work still pending\./);
  } finally {
    await fixture.cleanup();
  }
});

test('dashboardReducer surfaces token-limit pauses with the explicit reason', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir, {
      tokenBudget: {
        limitTokens: 1620,
        baselineTokens: 0
      }
    });
    const context = makeContextSnapshot(config, {
      done: true,
      status: 'queued',
      iterationsRun: 1,
      iterationsTarget: 3,
      usageTotals: makeUsageTotals()
    });
    const summary = makeRunSummary([context], {
      completed: false,
      pauseReason: {
        code: 'token_limit',
        message: 'Token limit reached: 1,620 / 1,620 tokens used since the last budget reset'
      },
      usageTotals: makeUsageTotals(),
      contexts: [context]
    });

    const next = dashboardReducer(createInitialDashboardState(), {
      type: 'summary',
      summary
    });

    assert.equal(next.phase, 'done');
    assert.equal(next.activeStep, 'Token limit reached');
    assert.equal(buildSummaryPauseReason(summary), 'Token limit reached: 1,620 / 1,620 tokens used since the last budget reset');
    assert.match(next.notifications[0]?.body ?? '', /Token limit reached: 1,620 \/ 1,620 tokens used since the last budget reset\./);
    assert.match(buildRunSummaryText(summary), /Reason: Token limit reached: 1,620 \/ 1,620 tokens used since the last budget reset\./);
  } finally {
    await fixture.cleanup();
  }
});

test('dashboardReducer surfaces user-requested pauses with the explicit reason', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config, {
      done: true,
      status: 'queued',
      iterationsRun: 1,
      iterationsTarget: 3,
      lastStep: 'Paused at safe checkpoint'
    });
    const summary = makeRunSummary([context], {
      completed: false,
      pauseReason: {
        code: 'user_request',
        message: 'Paused by user request at a safe checkpoint; resume from the saved checkpoint when you are ready'
      },
      usageTotals: makeUsageTotals(),
      contexts: [context]
    });

    const next = dashboardReducer(createInitialDashboardState(), {
      type: 'summary',
      summary
    });

    assert.equal(next.phase, 'done');
    assert.equal(next.activeStep, 'Paused on request');
    assert.equal(
      buildSummaryPauseReason(summary),
      'Paused by user request at a safe checkpoint; resume from the saved checkpoint when you are ready'
    );
    assert.match(next.notifications[0]?.body ?? '', /Paused by user request at a safe checkpoint; resume from the saved checkpoint when you are ready\./);
  } finally {
    await fixture.cleanup();
  }
});

test('pause reason helpers explain iteration limits for unfinished contexts', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config, {
      done: false,
      status: 'queued',
      iterationsRun: 1,
      iterationsTarget: 1,
      storyProgress: '1/4 stories complete',
      backlogProgress: '1/4 tasks · 5/20 steps'
    });
    const summary = makeRunSummary([context], {
      completed: false,
      usageTotals: null,
      contexts: [context]
    });

    assert.equal(buildContextPauseReason(context), 'All configured passes used; work still pending');
    assert.equal(buildSummaryPauseReason(summary), 'All configured passes used; work still pending');
    assert.match(buildRunSummaryText(summary), /Reason: All configured passes used; work still pending\./);
  } finally {
    await fixture.cleanup();
  }
});

test('buildSummaryPauseReason summarizes exhausted pass budgets across multiple PRDs', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const foundationPrd = path.join(fixture.rootDir, 'docs', 'prds', 'foundation.md');
    const followUpPrd = path.join(fixture.rootDir, 'docs', 'prds', 'follow-up.md');
    const config = makeConfig(fixture.rootDir, {
      plans: [
        makePlan(foundationPrd, { id: 'foundation', title: 'foundation' }),
        makePlan(followUpPrd, { id: 'follow-up', title: 'follow-up' })
      ]
    });
    const completed = makeContextSnapshot(config, {
      index: 0,
      planId: 'foundation',
      sourcePrd: foundationPrd,
      title: 'foundation',
      done: true,
      status: 'complete',
      iterationsRun: 1,
      iterationsTarget: 1
    });
    const pending = makeContextSnapshot(config, {
      index: 1,
      planId: 'follow-up',
      sourcePrd: followUpPrd,
      title: 'follow-up',
      done: false,
      status: 'queued',
      iterationsRun: 3,
      iterationsTarget: 3
    });
    const summary = makeRunSummary([completed, pending], {
      completed: false,
      usageTotals: null,
      contexts: [completed, pending]
    });

    assert.equal(buildSummaryPauseReason(summary), '1 PRD used all configured passes');
  } finally {
    await fixture.cleanup();
  }
});

test('resolveContextUsageTotals falls back to iteration history when the context total is missing', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir);
    const usageTotals = makeUsageTotals({
      totalTokens: 2450,
      totalCostUsd: 0.91
    });
    const context = makeContextSnapshot(config, {
      usageTotals: null,
      iterationHistory: [
        {
          iteration: 1,
          attempt: 1,
          durationMs: 1200,
          exitCode: 0,
          lineCount: 42,
          lastStep: 'Complete',
          logPath: path.join(fixture.rootDir, '.ralphi', 'state', 'sample', 'logs', 'latest.log'),
          promptPath: path.join(fixture.rootDir, '.ralphi', 'state', 'sample', 'prompts', 'latest.md'),
          promptPreviewPath: path.join(fixture.rootDir, '.ralphi', 'state', 'sample', 'prompts', 'latest.preview.md'),
          promptSourcesPath: path.join(fixture.rootDir, '.ralphi', 'state', 'sample', 'prompts', 'latest.sources.md'),
          touchedFiles: [],
          usageTotals,
          mcpServers: [],
          failure: null,
          completed: true
        }
      ]
    });

    assert.deepEqual(resolveContextUsageTotals(context), usageTotals);
  } finally {
    await fixture.cleanup();
  }
});

test('buildCompletionUsageRows exposes cost used when spend is available', () => {
  const rows = buildCompletionUsageRows(makeUsageTotals({
    totalTokens: 1620,
    totalCostUsd: 0.42,
    currency: 'USD'
  }));

  assert.deepEqual(rows, [
    {
      label: 'Tokens',
      value: '1,620'
    },
    {
      label: 'Cost Used',
      value: '$0.42'
    }
  ]);
});

test('buildCompletionUsageRows keeps a tokens row even when only input and output counters are available', () => {
  const rows = buildCompletionUsageRows({
    inputTokens: 1800,
    cachedInputTokens: 200,
    outputTokens: 420,
    reasoningOutputTokens: null,
    totalTokens: null,
    totalCostUsd: null,
    currency: null
  });

  assert.deepEqual(rows, [
    {
      label: 'Tokens',
      value: 'input 1,800 · cached 200 · output 420'
    }
  ]);
});

test('classifySignalTone highlights commands, diffs, and failures in the live feed', () => {
  assert.equal(classifySignalTone('npm run build'), 'command');
  assert.equal(classifySignalTone('+added line'), 'diff-add');
  assert.equal(classifySignalTone('Error: provider crashed'), 'error');
});

test('buildRunSummaryText mentions the final merged branch when one is available', async () => {
  const fixture = await createTempProject('ralphi-dashboard-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config, {
      done: true,
      status: 'complete'
    });
    const summary = makeRunSummary([context], {
      completed: true,
      finalBranchName: 'ralphi/merged-abc123',
      contexts: [context]
    });

    assert.match(buildRunSummaryText(summary), /Final branch: ralphi\/merged-abc123\./);
  } finally {
    await fixture.cleanup();
  }
});
