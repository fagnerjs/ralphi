import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import {
  addBacklogItem,
  applyBacklogMarker,
  editBacklogItem,
  ensureBacklogFromPrd,
  isBacklogComplete,
  removeBacklogItem,
  setBacklogItemStatus
} from './backlog.js';
import { createTempProject, makeBacklogSnapshot } from '../test-support.js';

test('ensureBacklogFromPrd derives items and steps from a markdown PRD', async () => {
  const fixture = await createTempProject('ralphi-backlog-');

  try {
    const sourcePrd = path.join(fixture.rootDir, 'docs', 'prds', 'release-console.md');
    const backlogPath = path.join(fixture.ralphDir, 'state', 'release-console', 'backlog.json');
    const prdJsonPath = path.join(fixture.ralphDir, 'state', 'release-console', 'prd.json');

    await writeFile(
      sourcePrd,
      `# PRD: Release console

## Introduction

Run launches from one place.

## User Stories

### US-001: Triage blockers
**Description:** As a release lead, I need active blockers in one queue.

**Acceptance Criteria:**
- [ ] Surface all open blockers
- [ ] Keep the owner visible
`,
      'utf8'
    );

    const backlog = await ensureBacklogFromPrd(sourcePrd, prdJsonPath, backlogPath);

    assert.equal(backlog.items.length, 1);
    assert.equal(backlog.items[0]?.storyId, 'US-001');
    assert.equal(backlog.items[0]?.steps.length, 2);
    assert.equal(backlog.items[0]?.steps[0]?.title, 'Surface all open blockers');
  } finally {
    await fixture.cleanup();
  }
});

test('addBacklogItem, editBacklogItem, and removeBacklogItem manage custom tasks and pointers', () => {
  const base = makeBacklogSnapshot({
    activeItemId: null,
    activeStepId: null,
    items: []
  });

  const added = addBacklogItem(base, 'Prepare rollout note', 'Summarize the latest status.');
  const createdItem = added.items[0];
  assert.equal(added.items.length, 1);
  assert.equal(createdItem?.source, 'custom');
  assert.equal(added.activeItemId, createdItem?.id ?? null);
  assert.equal(added.activeStepId, createdItem?.steps[0]?.id ?? null);

  const edited = editBacklogItem(added, createdItem?.id ?? '', {
    title: 'Prepare launch note',
    description: 'Summarize blockers and owners.'
  });
  assert.equal(edited.items[0]?.title, 'Prepare launch note');
  assert.equal(edited.items[0]?.description, 'Summarize blockers and owners.');

  const removed = removeBacklogItem(edited, createdItem?.id ?? '');
  assert.equal(removed.items.length, 0);
  assert.equal(removed.activeItemId, null);
  assert.equal(removed.activeStepId, null);
});

test('setBacklogItemStatus cascades done and disabled state into each step', () => {
  const backlog = makeBacklogSnapshot();
  const itemId = backlog.items[0]?.id ?? '';

  const done = setBacklogItemStatus(backlog, itemId, 'done');
  assert.equal(done.items[0]?.status, 'done');
  assert.ok(done.items[0]?.steps.every(step => step.status === 'done'));

  const disabled = setBacklogItemStatus(backlog, itemId, 'disabled');
  assert.equal(disabled.items[0]?.status, 'disabled');
  assert.ok(disabled.items[0]?.steps.every(step => step.status === 'disabled'));
});

test('applyBacklogMarker updates the active step and reflects execution progress', () => {
  const backlog = makeBacklogSnapshot({
    items: [
      {
        id: 'BT-001',
        storyId: 'US-001',
        title: 'Ship the dashboard',
        description: 'Finish the first task.',
        status: 'pending',
        notes: '',
        steps: [
          { id: 'ST-001-01', title: 'Build the panel', status: 'pending' },
          { id: 'ST-001-02', title: 'Wire the events', status: 'pending' }
        ],
        updatedAt: '2026-03-07T00:00:00.000Z',
        source: 'prd',
        manualTitle: null,
        manualDescription: null
      }
    ]
  });

  const started = applyBacklogMarker(backlog, {
    itemId: 'BT-001',
    stepId: 'ST-001-01',
    status: 'in_progress'
  });
  const finished = applyBacklogMarker(started, {
    itemId: 'BT-001',
    stepId: 'ST-001-01',
    status: 'done'
  });

  assert.equal(started?.activeStepId, 'ST-001-01');
  assert.equal(started?.items[0]?.status, 'in_progress');
  assert.equal(finished?.items[0]?.steps[0]?.status, 'done');
  assert.equal(finished?.completedSteps, 1);
});

test('isBacklogComplete only returns true when all enabled items and steps are complete', () => {
  const pending = makeBacklogSnapshot({
    completedItems: 1,
    totalItems: 4,
    completedSteps: 5,
    totalSteps: 20
  });
  const complete = makeBacklogSnapshot({
    items: [
      {
        id: 'BT-001',
        storyId: 'US-001',
        title: 'Ship the dashboard',
        description: 'Finish the first task.',
        status: 'done',
        notes: '',
        steps: [
          { id: 'ST-001-01', title: 'Build the panel', status: 'done' },
          { id: 'ST-001-02', title: 'Wire the events', status: 'done' }
        ],
        updatedAt: '2026-03-07T00:00:00.000Z',
        source: 'prd',
        manualTitle: null,
        manualDescription: null
      }
    ],
    completedItems: 1,
    totalItems: 1,
    completedSteps: 2,
    totalSteps: 2,
    activeItemId: null,
    activeStepId: null
  });

  assert.equal(isBacklogComplete(null), false);
  assert.equal(isBacklogComplete(pending), false);
  assert.equal(isBacklogComplete(complete), true);
});
