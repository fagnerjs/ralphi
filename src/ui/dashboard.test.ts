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
    assert.match(next.notifications[0]?.body ?? '', /1,620 tokens/);
    assert.match(buildRunSummaryText(summary), /1 commit ready for review/);
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
    assert.equal(next.activeStep, 'Paused after 1/1 iteration');
    assert.equal(next.notifications[0]?.title, 'Execution paused');
    assert.match(next.notifications[0]?.body ?? '', /Reason: stopped after 1\/1 iteration with work still pending\./);
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

    assert.equal(buildContextPauseReason(context), 'stopped after 1/1 iteration with work still pending');
    assert.equal(buildSummaryPauseReason(summary), 'stopped after 1/1 iteration with work still pending');
    assert.match(buildRunSummaryText(summary), /Reason: stopped after 1\/1 iteration with work still pending\./);
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
