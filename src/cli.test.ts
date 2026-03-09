import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import { createInitialConfig, materializeDraftIfNeeded, parseArgs, usage } from './cli.js';
import { pathExists, writeJsonFile } from './core/utils.js';
import { createTempProject } from './test-support.js';

test('usage advertises the main run and maintenance commands', () => {
  const text = usage();

  assert.match(text, /ralphi doctor/);
  assert.match(text, /ralphi prompt preview --prds file1/);
  assert.match(text, /--create-prd \"brief\"/);
  assert.match(text, /--max-tokens N/);
  assert.match(text, /copilot|cursor/);
});

test('parseArgs handles run options and subcommands', () => {
  const run = parseArgs([
    '--tool',
    'copilot',
    '--prds',
    'docs/prds/release.md',
    '--schedule=parallel',
    '--workspace',
    'shared',
    '--environment',
    'devcontainer',
    '--max-iterations',
    '8',
    '--max-tokens',
    '32000',
    '--per-prd-iterations',
    '3,5'
  ]);
  const subcommand = parseArgs(['worktree', 'cleanup', '--dry-run']);

  assert.equal(run.command, 'run');
  assert.equal(run.tool, 'copilot');
  assert.equal(run.schedule, 'parallel');
  assert.equal(run.workspaceStrategy, 'shared');
  assert.equal(run.executionEnvironment, 'devcontainer');
  assert.equal(run.maxTokens, 32000);
  assert.deepEqual(run.perPrdIterations, [3, 5]);
  assert.equal(subcommand.command, 'worktree-cleanup');
  assert.equal(subcommand.dryRun, true);
});

test('createInitialConfig turns --max-tokens into an execution token budget', async () => {
  const fixture = await createTempProject('ralphi-cli-');

  try {
    const prdPath = path.join(fixture.rootDir, 'docs', 'prds', 'release.md');
    await writeFile(prdPath, '# PRD: Release\n', 'utf8');

    const config = await createInitialConfig(parseArgs(['--prds', 'docs/prds/release.md', '--max-tokens', '24000']), fixture.rootDir, fixture.rootDir);

    assert.deepEqual(config.tokenBudget, {
      limitTokens: 24000,
      baselineTokens: 0
    });
  } finally {
    await fixture.cleanup();
  }
});

test('createInitialConfig applies project defaults and keeps devcontainer mode when the config exists', async () => {
  const fixture = await createTempProject('ralphi-cli-');

  try {
    const prdPath = path.join(fixture.rootDir, 'docs', 'prds', 'release.md');
    await writeFile(prdPath, '# PRD: Release\n', 'utf8');
    await writeJsonFile(path.join(fixture.rootDir, '.ralphi.json'), {
      version: 1,
      defaults: {
        tool: 'codex',
        schedule: 'per-prd',
        workspaceStrategy: 'shared',
        iterations: 7,
        environment: 'devcontainer',
        verbose: true
      },
      skills: []
    });
    await writeJsonFile(path.join(fixture.rootDir, '.devcontainer.json'), {
      name: 'fixture'
    });

    const config = await createInitialConfig(parseArgs(['--prds', 'docs/prds/release.md']), fixture.rootDir, fixture.rootDir);

    assert.equal(config.tool, 'codex');
    assert.equal(config.schedule, 'per-prd');
    assert.equal(config.workspaceStrategy, 'shared');
    assert.equal(config.maxIterations, 7);
    assert.equal(config.executionEnvironment, 'devcontainer');
    assert.equal(config.verbose, true);
    assert.equal(config.plans.length, 1);
    assert.equal(config.ralphDir, path.join(fixture.rootDir, '.ralphi'));
  } finally {
    await fixture.cleanup();
  }
});

test('materializeDraftIfNeeded turns a create-prd launch into a concrete plan', async () => {
  const fixture = await createTempProject('ralphi-cli-');

  try {
    const config = await createInitialConfig(parseArgs(['--create-prd', 'Release command center']), fixture.rootDir, fixture.rootDir);
    const materialized = await materializeDraftIfNeeded(config);

    assert.equal(materialized.launchMode, 'run-existing');
    assert.equal(materialized.plans.length, 1);
    assert.equal(await pathExists(materialized.plans[0]?.sourcePrd ?? ''), true);
    assert.match(path.basename(materialized.plans[0]?.sourcePrd ?? ''), /^prd-release-command-center/);
  } finally {
    await fixture.cleanup();
  }
});
