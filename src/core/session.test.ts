import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

import {
  clearRunState,
  contextCheckpointPath,
  loadPendingRunSession,
  loadRunSession,
  prepareContextRetry,
  runSessionPath,
  saveContextCheckpoint,
  saveRunSession
} from './session.js';
import { pathExists } from './utils.js';
import { createTempProject, makeConfig, makeContextSnapshot, makePlan, makeRunSummary } from '../test-support.js';

test('saveRunSession persists pending sessions and hides completed ones from resume flow', async () => {
  const fixture = await createTempProject('ralphi-session-');

  try {
    const sourcePrd = path.join(fixture.rootDir, 'docs', 'prds', 'release.md');
    const config = makeConfig(fixture.rootDir, {
      plans: [makePlan(sourcePrd)]
    });

    const blocked = await saveRunSession(fixture.ralphDir, config, 'blocked');
    const pending = await loadPendingRunSession(fixture.ralphDir);

    assert.equal(blocked.status, 'blocked');
    assert.equal(pending?.status, 'blocked');

    await saveRunSession(fixture.ralphDir, config, 'complete', makeRunSummary([], { completed: true, contexts: [] }));
    const complete = await loadRunSession(fixture.ralphDir);

    assert.equal(complete?.status, 'complete');
    assert.equal(await loadPendingRunSession(fixture.ralphDir), null);
  } finally {
    await fixture.cleanup();
  }
});

test('prepareContextRetry re-queues a retryable checkpoint only once', async () => {
  const fixture = await createTempProject('ralphi-session-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config, {
      status: 'blocked',
      iterationsRun: 2,
      lastFailure: {
        category: 'provider_runtime',
        retryable: true,
        retryCount: 0,
        summary: 'Provider crashed',
        recoveryHint: 'Fix the provider and retry.',
        rawLogPath: null
      }
    });

    await mkdir(context.runDir, { recursive: true });
    await saveContextCheckpoint(context);

    const retried = await prepareContextRetry(context.runDir);
    const blockedAgain = await prepareContextRetry(context.runDir);

    assert.equal(retried?.status, 'queued');
    assert.equal(retried?.iterationsRun, 1);
    assert.equal(retried?.lastFailure?.retryCount, 1);
    assert.equal(blockedAgain, null);
  } finally {
    await fixture.cleanup();
  }
});

test('clearRunState removes checkpoint directories and the saved run session', async () => {
  const fixture = await createTempProject('ralphi-session-');

  try {
    const config = makeConfig(fixture.rootDir);
    const context = makeContextSnapshot(config);

    await mkdir(context.runDir, { recursive: true });
    await saveContextCheckpoint(context);
    await saveRunSession(fixture.ralphDir, config, 'blocked');

    assert.equal(await pathExists(contextCheckpointPath(context.runDir)), true);
    assert.equal(await pathExists(runSessionPath(fixture.ralphDir)), true);

    await clearRunState(config);

    assert.equal(await pathExists(context.runDir), false);
    assert.equal(await pathExists(runSessionPath(fixture.ralphDir)), false);
  } finally {
    await fixture.cleanup();
  }
});
