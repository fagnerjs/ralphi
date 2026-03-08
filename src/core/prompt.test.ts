import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import { buildPrompt } from './prompt.js';
import { createTempProject } from '../test-support.js';

test('buildPrompt describes iterations as full PRD passes across the backlog', async () => {
  const fixture = await createTempProject('ralphi-prompt-');

  try {
    const sourcePrd = path.join(fixture.rootDir, 'docs', 'prds', 'sample.md');
    const runDir = path.join(fixture.ralphDir, 'state', 'sample-run');
    const prdJsonPath = path.join(runDir, 'prd.json');
    const progressFilePath = path.join(runDir, 'progress.txt');
    const backlogPath = path.join(runDir, 'backlog.json');
    await writeFile(sourcePrd, '# PRD: Sample\n', 'utf8');

    const prompt = await buildPrompt({
      rootDir: fixture.rootDir,
      ralphDir: fixture.ralphDir,
      tool: 'codex',
      sourcePrd,
      runDir,
      prdJsonPath,
      progressFilePath,
      backlogPath,
      workspaceDir: fixture.rootDir,
      branchName: 'feature/sample',
      baseRef: 'main',
      iteration: 2,
      totalIterations: 5,
      scheduleMode: 'round-robin',
      trackLabel: 'Wave 1/5 | PRD 1/1',
      prdPosition: 1,
      prdTotal: 1,
      skillRegistry: '## Skills\n- none'
    });

    assert.match(prompt, /PRD pass: 2 of 5/);
    assert.match(prompt, /Treat this pass as one complete PRD pass across the backlog, not as a budget for only one backlog item\./);
    assert.match(prompt, /When you finish one item, continue to the next incomplete enabled item in the same pass whenever safe progress remains\./);
    assert.match(prompt, /move `activeItemId`\/`activeStepId` to the next incomplete enabled work item when possible\./);
    assert.doesNotMatch(prompt, /Execute the next incomplete backlog item only\./);
  } finally {
    await fixture.cleanup();
  }
});

test('buildPrompt explains dependency context when a PRD depends on another selected PRD', async () => {
  const fixture = await createTempProject('ralphi-prompt-');

  try {
    const sourcePrd = path.join(fixture.rootDir, 'docs', 'prds', 'dependent.md');
    const dependencyPrd = path.join(fixture.rootDir, 'docs', 'prds', 'foundation.md');
    const runDir = path.join(fixture.ralphDir, 'state', 'dependent-run');
    const prdJsonPath = path.join(runDir, 'prd.json');
    const progressFilePath = path.join(runDir, 'progress.txt');
    const backlogPath = path.join(runDir, 'backlog.json');
    await writeFile(sourcePrd, '# PRD: Dependent\n', 'utf8');
    await writeFile(dependencyPrd, '# PRD: Foundation\n', 'utf8');

    const prompt = await buildPrompt({
      rootDir: fixture.rootDir,
      ralphDir: fixture.ralphDir,
      tool: 'codex',
      sourcePrd,
      runDir,
      prdJsonPath,
      progressFilePath,
      backlogPath,
      workspaceDir: fixture.rootDir,
      branchName: 'feature/dependent',
      baseRef: 'feature/foundation-run-1234',
      dependsOnTitle: 'foundation',
      dependsOnSourcePrd: dependencyPrd,
      dependsOnBranch: 'feature/foundation-run-1234',
      iteration: 1,
      totalIterations: 3,
      scheduleMode: 'parallel',
      trackLabel: 'Parallel agent 2/2 | Pass 1/3',
      prdPosition: 2,
      prdTotal: 2,
      skillRegistry: '## Skills\n- none'
    });

    assert.match(prompt, /Depends on PRD: foundation/);
    assert.match(prompt, /Dependency branch: feature\/foundation-run-1234/);
    assert.match(prompt, /Treat the implementation already present on feature\/foundation-run-1234 as the baseline/);
  } finally {
    await fixture.cleanup();
  }
});
