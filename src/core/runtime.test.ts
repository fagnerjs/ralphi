import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import {
  buildPlansFromPrds,
  createPrdDraftFromBrief,
  isContextPersistedStateComplete,
  parsePerPrdIterations,
  resolvePlanStatePaths,
  resolvePrdFiles,
  runRalphi,
  scanPrdDirectory,
  validateProvider
} from './runtime.js';
import { createTempProject, makeBacklogSnapshot, makeConfig, makePlan, writeExecutable } from '../test-support.js';
import { gitBranchExists, runGitCommand } from './git.js';
import { pathExists, writeJsonFile } from './utils.js';

async function runGitOk(rootDir: string, args: string[]): Promise<string> {
  const result = await runGitCommand(rootDir, args);
  assert.equal(result.code, 0, result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

async function writeFakeCodex(binDir: string): Promise<string> {
  const body = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'prompt_file="$(mktemp)"',
    'cat > "$prompt_file"',
    "node - \"$prompt_file\" <<'NODE'",
    "const fs = require('fs');",
    "const path = require('path');",
    "const { execFileSync } = require('child_process');",
    '',
    "const promptPath = process.argv[2];",
    "const prompt = fs.readFileSync(promptPath, 'utf8');",
    '',
    'function readField(label) {',
    "  const prefix = '- ' + label + ': ';",
    "  const line = prompt.split(/\\r?\\n/).find(candidate => candidate.startsWith(prefix));",
    "  return line ? line.slice(prefix.length).trim() : '';",
    '}',
    '',
    '(async () => {',
    "  const sourcePrd = readField('Source PRD');",
    "  const prdJsonPath = readField('PRD JSON path');",
    "  const backlogPath = readField('Backlog path');",
    "  const progressFilePath = readField('Progress log');",
    "  const branchName = execFileSync('git', ['branch', '--show-current'], { cwd: process.cwd(), encoding: 'utf8' }).trim();",
    "  const featuresDir = path.join(process.cwd(), 'features');",
    "  const prdName = path.basename(sourcePrd);",
    '',
    "  fs.mkdirSync(featuresDir, { recursive: true });",
    '',
    "  if (prdName.includes('foundation')) {",
    '    await new Promise(resolve => setTimeout(resolve, 150));',
    "    fs.writeFileSync(path.join(featuresDir, 'foundation.txt'), 'foundation ready on ' + branchName + '\\n', 'utf8');",
    "  } else if (prdName.includes('follow-up')) {",
    "    const foundationPath = path.join(featuresDir, 'foundation.txt');",
    "    if (!fs.existsSync(foundationPath)) {",
    "      console.error('Missing dependency baseline in the dependent worktree.');",
    '      process.exit(1);',
    '    }',
    '',
    "    const foundationContent = fs.readFileSync(foundationPath, 'utf8').trim();",
    "    fs.writeFileSync(path.join(featuresDir, 'follow-up.txt'), 'follow-up built on ' + branchName + '\\nfoundation=' + foundationContent + '\\n', 'utf8');",
    '  } else {',
    "    fs.writeFileSync(path.join(featuresDir, 'generic.txt'), 'completed on ' + branchName + '\\n', 'utf8');",
    '  }',
    '',
    "  const prd = JSON.parse(fs.readFileSync(prdJsonPath, 'utf8'));",
    '  prd.userStories = (prd.userStories ?? []).map((story, index) => ({',
    '    ...story,',
    "    id: story.id ?? ('US-' + String(index + 1).padStart(3, '0')),",
    '    passes: true,',
    "    notes: 'Completed on ' + branchName",
    '  }));',
    "  fs.writeFileSync(prdJsonPath, JSON.stringify(prd, null, 2) + '\\n', 'utf8');",
    '',
    "  const backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8'));",
    '  backlog.activeItemId = null;',
    '  backlog.activeStepId = null;',
    '  backlog.items = (backlog.items ?? []).map(item => ({',
    '    ...item,',
    "    status: item.status === 'disabled' ? 'disabled' : 'done',",
    '    steps: (item.steps ?? []).map(step => ({',
    '      ...step,',
    "      status: step.status === 'disabled' ? 'disabled' : 'done'",
    '    }))',
    '  }));',
    "  fs.writeFileSync(backlogPath, JSON.stringify(backlog, null, 2) + '\\n', 'utf8');",
    '',
    "  fs.appendFileSync(progressFilePath, '\\n- Completed ' + prdName + ' on ' + branchName + '\\n', 'utf8');",
    "  console.log('<ralphi-backlog item=\"BT-001\" step=\"ST-001-01\" status=\"done\">');",
    "  console.log('Usage summary · input tokens 1,200 · cached input tokens 100 · output tokens 320 · total tokens 1,620 · spend $0.42');",
    "  console.log('<promise>COMPLETE</promise>');",
    '})().catch(error => {',
    "  console.error(error instanceof Error ? error.stack || error.message : String(error));",
    '  process.exit(1);',
    '}).finally(() => {',
    "  fs.rmSync(promptPath, { force: true });",
    '});',
    'NODE',
    'rm -f "$prompt_file"',
    ''
  ].join('\n');

  return writeExecutable(binDir, 'codex', body);
}

test('scanPrdDirectory returns the newest PRDs from docs/prds first', async () => {
  const fixture = await createTempProject('ralphi-runtime-');

  try {
    const first = path.join(fixture.rootDir, 'docs', 'prds', 'older.md');
    const second = path.join(fixture.rootDir, 'docs', 'prds', 'newer.md');
    await writeFile(first, '# PRD: Older\n', 'utf8');
    await delay(25);
    await writeFile(second, '# PRD: Newer\n', 'utf8');

    const files = await scanPrdDirectory(fixture.rootDir);

    assert.deepEqual(files, [second, first]);
  } finally {
    await fixture.cleanup();
  }
});

test('resolvePrdFiles resolves relative input and prefers .ralphi/prd.json before the legacy fallback', async () => {
  const fixture = await createTempProject('ralphi-runtime-');

  try {
    const explicitPrd = path.join(fixture.rootDir, 'docs', 'prds', 'release.md');
    const fallbackPrd = path.join(fixture.ralphDir, 'prd.json');
    const legacyFallbackPrd = path.join(fixture.rootDir, 'ralph', 'prd.json');
    await writeFile(explicitPrd, '# PRD: Release\n', 'utf8');
    await mkdir(path.join(fixture.rootDir, 'ralph'), { recursive: true });
    await writeJsonFile(legacyFallbackPrd, { branchName: 'feature/legacy-release' });

    const explicit = await resolvePrdFiles(fixture.rootDir, 'docs/prds/release.md', fixture.rootDir);
    const legacyFallback = await resolvePrdFiles(fixture.rootDir, undefined, fixture.rootDir);
    await writeJsonFile(fallbackPrd, { branchName: 'feature/release' });
    const fallback = await resolvePrdFiles(fixture.rootDir, undefined, fixture.rootDir);

    assert.deepEqual(explicit, [explicitPrd]);
    assert.deepEqual(legacyFallback, [legacyFallbackPrd]);
    assert.deepEqual(fallback, [fallbackPrd]);
  } finally {
    await fixture.cleanup();
  }
});

test('buildPlansFromPrds respects explicit iteration counts and JSON branch names', async () => {
  const fixture = await createTempProject('ralphi-runtime-');

  try {
    const jsonPrd = path.join(fixture.rootDir, 'docs', 'prds', 'release.json');
    const markdownPrd = path.join(fixture.rootDir, 'docs', 'prds', 'follow-up.md');
    await writeJsonFile(jsonPrd, {
      branchName: 'feature/release-console'
    });
    await writeFile(markdownPrd, '# PRD: Follow up\n', 'utf8');

    const plans = await buildPlansFromPrds([jsonPrd, markdownPrd], 4, [6]);

    assert.equal(plans[0]?.iterations, 6);
    assert.equal(plans[1]?.iterations, 4);
    assert.equal(plans[0]?.branchName, 'feature/release-console');
    assert.match(plans[1]?.branchName ?? '', /follow-up/);
  } finally {
    await fixture.cleanup();
  }
});

test('createPrdDraftFromBrief creates unique markdown drafts and initializes state paths', async () => {
  const fixture = await createTempProject('ralphi-runtime-');

  try {
    const first = await createPrdDraftFromBrief(fixture.rootDir, 'Release command center');
    const second = await createPrdDraftFromBrief(fixture.rootDir, 'Release command center');

    assert.notEqual(first, second);
    assert.match(path.basename(first), /^prd-release-command-center\.md$/);
    assert.match(path.basename(second), /^prd-release-command-center-2\.md$/);

    const firstState = resolvePlanStatePaths(fixture.ralphDir, first);
    const secondState = resolvePlanStatePaths(fixture.ralphDir, second);

    assert.equal(path.dirname(firstState.runDir), path.join(fixture.ralphDir, 'state'));
    assert.equal(path.dirname(secondState.runDir), path.join(fixture.ralphDir, 'state'));
    assert.equal(await pathExists(firstState.runDir), true);
    assert.equal(await pathExists(secondState.runDir), true);
  } finally {
    await fixture.cleanup();
  }
});

test('createPrdDraftFromBrief respects provider planning timeout overrides', async () => {
  const fixture = await createTempProject('ralphi-runtime-');
  const previousPath = process.env.PATH;
  const previousPlanningTimeout = process.env.RALPHI_PROVIDER_PLANNING_TIMEOUT_MS;

  try {
    const binDir = path.join(fixture.rootDir, 'bin');
    const skillDir = path.join(fixture.rootDir, 'skills', 'slow-draft');
    const skillFile = path.join(skillDir, 'SKILL.md');

    await mkdir(skillDir, { recursive: true });
    await writeFile(skillFile, '# Slow draft skill\n', 'utf8');
    await writeExecutable(binDir, 'codex', '#!/usr/bin/env bash\nsleep 2\n');

    process.env.PATH = previousPath ? `${binDir}${path.delimiter}${previousPath}` : binDir;
    process.env.RALPHI_PROVIDER_PLANNING_TIMEOUT_MS = '100';

    await assert.rejects(
      createPrdDraftFromBrief(fixture.rootDir, 'Release command center', {
        skillName: 'slow-draft',
        skillFilePath: skillFile,
        provider: 'codex'
      }),
      /Provider "codex" timed out after 100ms\./
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousPlanningTimeout === undefined) {
      delete process.env.RALPHI_PROVIDER_PLANNING_TIMEOUT_MS;
    } else {
      process.env.RALPHI_PROVIDER_PLANNING_TIMEOUT_MS = previousPlanningTimeout;
    }
    await fixture.cleanup();
  }
});

test('validateProvider rejects missing provider executables and missing devcontainer prerequisites', async () => {
  const fixture = await createTempProject('ralphi-runtime-');
  const previousPath = process.env.PATH;

  try {
    const sourcePrd = path.join(fixture.rootDir, 'docs', 'prds', 'release.md');
    await writeFile(sourcePrd, '# PRD: Release\n', 'utf8');
    const binDir = path.join(fixture.rootDir, 'bin');
    await writeExecutable(binDir, 'codex');

    process.env.PATH = '';
    await assert.rejects(
      validateProvider(
        makeConfig(fixture.rootDir, {
          tool: 'codex',
          plans: [makePlan(sourcePrd)]
        })
      ),
      /Provider "codex" was not found in PATH/
    );

    process.env.PATH = binDir;
    await assert.rejects(
      validateProvider(
        makeConfig(fixture.rootDir, {
          tool: 'codex',
          plans: [makePlan(sourcePrd)],
          executionEnvironment: 'devcontainer',
          devcontainerConfigPath: null
        })
      ),
      /no devcontainer\.json file was found/
    );
  } finally {
    process.env.PATH = previousPath;
    await fixture.cleanup();
  }
});

test('parsePerPrdIterations parses positive iteration lists', () => {
  assert.deepEqual(parsePerPrdIterations('4, 6,8'), [4, 6, 8]);
});

test('isContextPersistedStateComplete requires both story passes and backlog completion', async () => {
  const fixture = await createTempProject('ralphi-runtime-');

  try {
    const prdJsonPath = path.join(fixture.ralphDir, 'state', 'sample', 'prd.json');
    await writeJsonFile(prdJsonPath, {
      userStories: [
        { id: 'US-001', title: 'One', passes: true },
        { id: 'US-002', title: 'Two', passes: true }
      ]
    });

    const done = await isContextPersistedStateComplete(
      prdJsonPath,
      makeBacklogSnapshot({
        completedItems: 1,
        totalItems: 4,
        completedSteps: 5,
        totalSteps: 20
      })
    );
    const complete = await isContextPersistedStateComplete(
      prdJsonPath,
      makeBacklogSnapshot({
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
      })
    );

    assert.equal(done, false);
    assert.equal(complete, true);
  } finally {
    await fixture.cleanup();
  }
});

test('runRalphi consumes the full configured iteration budget before marking a PRD complete', async () => {
  const fixture = await createTempProject('ralphi-runtime-');
  const previousPath = process.env.PATH;

  try {
    const releasePrd = path.join(fixture.rootDir, 'docs', 'prds', 'release.json');
    const binDir = path.join(fixture.rootDir, 'bin');

    await writeFile(path.join(fixture.rootDir, 'README.md'), '# Fixture repository\n', 'utf8');
    await writeJsonFile(releasePrd, {
      branchName: 'feature/release',
      userStories: [
        {
          id: 'US-001',
          title: 'Ship the release flow',
          description: 'Deliver the release flow.',
          acceptanceCriteria: ['Create release artifacts'],
          passes: false
        }
      ]
    });
    await writeFakeCodex(binDir);

    await runGitOk(fixture.rootDir, ['init', '-b', 'main']);
    await runGitOk(fixture.rootDir, ['config', 'user.name', 'Ralphi Test']);
    await runGitOk(fixture.rootDir, ['config', 'user.email', 'ralphi@example.com']);
    await runGitOk(fixture.rootDir, ['add', '.']);
    await runGitOk(fixture.rootDir, ['commit', '-m', 'chore: seed fixture']);

    process.env.PATH = previousPath ? `${binDir}${path.delimiter}${previousPath}` : binDir;

    const config = makeConfig(fixture.rootDir, {
      tool: 'codex',
      plans: [
        makePlan(releasePrd, {
          id: 'release',
          title: 'release',
          branchName: 'feature/release',
          iterations: 3
        })
      ],
      maxIterations: 3,
      schedule: 'per-prd',
      workspaceStrategy: 'shared'
    });
    const events: Array<Record<string, unknown>> = [];

    const summary = await runRalphi(config, async event => {
      events.push(event as Record<string, unknown>);
    });

    assert.equal(summary.completed, true);
    assert.equal(summary.contexts.length, 1);
    assert.equal(summary.contexts[0]?.done, true);
    assert.equal(summary.contexts[0]?.iterationsRun, 3);
    assert.equal(summary.contexts[0]?.iterationHistory.length, 3);
    assert.equal(events.filter(event => event.type === 'iteration-start').length, 3);
    assert.deepEqual(
      events.filter(event => event.type === 'iteration-finish').map(event => event.completed),
      [false, false, true]
    );

    const progressLog = await readFile(summary.contexts[0].progressFilePath, 'utf8');
    assert.equal((progressLog.match(/^- Completed release\.json on /gm) ?? []).length, 3);
  } finally {
    process.env.PATH = previousPath;
    await fixture.cleanup();
  }
});

test('runRalphi tracks provider usage totals and emits live usage updates', async () => {
  const fixture = await createTempProject('ralphi-runtime-');
  const previousPath = process.env.PATH;

  try {
    const releasePrd = path.join(fixture.rootDir, 'docs', 'prds', 'release.json');
    const binDir = path.join(fixture.rootDir, 'bin');

    await writeFile(path.join(fixture.rootDir, 'README.md'), '# Fixture repository\n', 'utf8');
    await writeJsonFile(releasePrd, {
      branchName: 'feature/release',
      userStories: [
        {
          id: 'US-001',
          title: 'Ship the release flow',
          description: 'Deliver the release flow.',
          acceptanceCriteria: ['Create release artifacts'],
          passes: false
        }
      ]
    });
    await writeFakeCodex(binDir);

    await runGitOk(fixture.rootDir, ['init', '-b', 'main']);
    await runGitOk(fixture.rootDir, ['config', 'user.name', 'Ralphi Test']);
    await runGitOk(fixture.rootDir, ['config', 'user.email', 'ralphi@example.com']);
    await runGitOk(fixture.rootDir, ['add', '.']);
    await runGitOk(fixture.rootDir, ['commit', '-m', 'chore: seed fixture']);

    process.env.PATH = previousPath ? `${binDir}${path.delimiter}${previousPath}` : binDir;

    const config = makeConfig(fixture.rootDir, {
      tool: 'codex',
      plans: [
        makePlan(releasePrd, {
          id: 'release',
          title: 'release',
          branchName: 'feature/release',
          iterations: 1
        })
      ],
      maxIterations: 1,
      schedule: 'per-prd',
      workspaceStrategy: 'shared'
    });
    const events: Array<Record<string, unknown>> = [];

    const summary = await runRalphi(config, async event => {
      events.push(event as Record<string, unknown>);
    });

    const usageUpdates = events.filter(event => event.type === 'usage-update');
    assert.equal(usageUpdates.length > 0, true);
    assert.equal(summary.contexts[0]?.usageTotals?.totalTokens, 1620);
    assert.equal(summary.contexts[0]?.usageTotals?.totalCostUsd, 0.42);
    assert.equal(summary.usageTotals?.totalTokens, 1620);
    assert.equal(summary.usageTotals?.totalCostUsd, 0.42);
  } finally {
    process.env.PATH = previousPath;
    await fixture.cleanup();
  }
});

test('runRalphi lets dependent PRDs consume their full budget in round-robin mode', async () => {
  const fixture = await createTempProject('ralphi-runtime-');
  const previousPath = process.env.PATH;

  try {
    const foundationPrd = path.join(fixture.rootDir, 'docs', 'prds', 'foundation.json');
    const followUpPrd = path.join(fixture.rootDir, 'docs', 'prds', 'follow-up.json');
    const binDir = path.join(fixture.rootDir, 'bin');

    await writeFile(path.join(fixture.rootDir, 'README.md'), '# Fixture repository\n', 'utf8');
    await writeJsonFile(foundationPrd, {
      branchName: 'feature/foundation',
      userStories: [
        {
          id: 'US-001',
          title: 'Build the foundation',
          description: 'Create the shared foundation artifact.',
          acceptanceCriteria: ['Create foundation.txt'],
          passes: false
        }
      ]
    });
    await writeJsonFile(followUpPrd, {
      branchName: 'feature/follow-up',
      userStories: [
        {
          id: 'US-002',
          title: 'Extend the foundation',
          description: 'Build the dependent artifact from the foundation baseline.',
          acceptanceCriteria: ['Create follow-up.txt from the foundation baseline'],
          passes: false
        }
      ]
    });
    await writeFakeCodex(binDir);

    await runGitOk(fixture.rootDir, ['init', '-b', 'main']);
    await runGitOk(fixture.rootDir, ['config', 'user.name', 'Ralphi Test']);
    await runGitOk(fixture.rootDir, ['config', 'user.email', 'ralphi@example.com']);
    await runGitOk(fixture.rootDir, ['add', '.']);
    await runGitOk(fixture.rootDir, ['commit', '-m', 'chore: seed fixture']);

    process.env.PATH = previousPath ? `${binDir}${path.delimiter}${previousPath}` : binDir;

    const config = makeConfig(fixture.rootDir, {
      tool: 'codex',
      plans: [
        makePlan(foundationPrd, {
          id: 'foundation',
          title: 'foundation',
          branchName: 'feature/foundation',
          iterations: 2
        }),
        makePlan(followUpPrd, {
          id: 'follow-up',
          title: 'follow-up',
          branchName: 'feature/follow-up',
          iterations: 2,
          dependsOn: 'foundation'
        })
      ],
      maxIterations: 2,
      schedule: 'round-robin',
      workspaceStrategy: 'worktree'
    });

    const summary = await runRalphi(config);
    const foundationContext = summary.contexts.find(context => context.planId === 'foundation');
    const followUpContext = summary.contexts.find(context => context.planId === 'follow-up');

    assert.equal(summary.completed, true);
    assert.equal(foundationContext?.iterationsRun, 2);
    assert.equal(followUpContext?.iterationsRun, 2);
    assert.equal(foundationContext?.done, true);
    assert.equal(followUpContext?.done, true);
  } finally {
    process.env.PATH = previousPath;
    await fixture.cleanup();
  }
});

test('runRalphi creates a final merged branch and cleans only current execution artifacts', async () => {
  const fixture = await createTempProject('ralphi-runtime-');
  const previousPath = process.env.PATH;

  try {
    const foundationPrd = path.join(fixture.rootDir, 'docs', 'prds', 'foundation.json');
    const followUpPrd = path.join(fixture.rootDir, 'docs', 'prds', 'follow-up.json');
    const binDir = path.join(fixture.rootDir, 'bin');

    await writeFile(path.join(fixture.rootDir, 'README.md'), '# Fixture repository\n', 'utf8');
    await writeJsonFile(foundationPrd, {
      branchName: 'feature/foundation',
      userStories: [
        {
          id: 'US-001',
          title: 'Build the foundation',
          description: 'Create the shared foundation artifact.',
          acceptanceCriteria: ['Create foundation.txt'],
          passes: false
        }
      ]
    });
    await writeJsonFile(followUpPrd, {
      branchName: 'feature/follow-up',
      userStories: [
        {
          id: 'US-002',
          title: 'Extend the foundation',
          description: 'Build the dependent artifact from the foundation branch.',
          acceptanceCriteria: ['Create follow-up.txt from the foundation baseline'],
          passes: false
        }
      ]
    });
    await writeFakeCodex(binDir);

    await runGitOk(fixture.rootDir, ['init', '-b', 'main']);
    await runGitOk(fixture.rootDir, ['config', 'user.name', 'Ralphi Test']);
    await runGitOk(fixture.rootDir, ['config', 'user.email', 'ralphi@example.com']);
    await runGitOk(fixture.rootDir, ['add', '.']);
    await runGitOk(fixture.rootDir, ['commit', '-m', 'chore: seed fixture']);

    const preservedWorktree = path.join(fixture.rootDir, '.worktrees', 'ralphi', 'preserved-other-execution');
    await runGitOk(fixture.rootDir, ['worktree', 'add', '-b', 'other-run-preserved', preservedWorktree, 'main']);

    process.env.PATH = previousPath ? `${binDir}${path.delimiter}${previousPath}` : binDir;

    const foundationPlan = makePlan(foundationPrd, {
      id: 'foundation',
      title: 'foundation',
      branchName: 'feature/foundation',
      iterations: 1
    });
    const followUpPlan = makePlan(followUpPrd, {
      id: 'follow-up',
      title: 'follow-up',
      branchName: 'feature/follow-up',
      iterations: 1,
      dependsOn: 'foundation'
    });

    const config = makeConfig(fixture.rootDir, {
      tool: 'codex',
      plans: [foundationPlan, followUpPlan],
      maxIterations: 1,
      schedule: 'parallel',
      workspaceStrategy: 'worktree'
    });
    const events: Array<Record<string, unknown>> = [];

    const summary = await runRalphi(config, async event => {
      events.push(event as Record<string, unknown>);
    });

    assert.equal(summary.completed, true);
    assert.match(summary.finalBranchName ?? '', /^ralphi\/merged-/);
    assert.equal(summary.contexts.length, 2);

    const foundationContext = summary.contexts[0];
    const followUpContext = summary.contexts[1];

    assert.ok(foundationContext.branchName);
    assert.ok(followUpContext.branchName);
    assert.ok(foundationContext.worktreePath);
    assert.ok(followUpContext.worktreePath);
    assert.equal(followUpContext.dependsOnPlanId, foundationContext.planId);
    assert.equal(followUpContext.baseRef, foundationContext.branchName);
    assert.equal(foundationContext.done, true);
    assert.equal(followUpContext.done, true);
    assert.equal(foundationContext.worktreeRemoved, true);
    assert.equal(followUpContext.worktreeRemoved, true);
    assert.equal(foundationContext.branchRemoved, true);
    assert.equal(followUpContext.branchRemoved, true);

    assert.equal(await gitBranchExists(fixture.rootDir, foundationContext.branchName), false);
    assert.equal(await gitBranchExists(fixture.rootDir, followUpContext.branchName), false);
    assert.equal(await pathExists(foundationContext.worktreePath), false);
    assert.equal(await pathExists(followUpContext.worktreePath), false);

    assert.equal(await gitBranchExists(fixture.rootDir, summary.finalBranchName ?? ''), true);
    assert.equal(await gitBranchExists(fixture.rootDir, 'other-run-preserved'), true);
    assert.equal(await pathExists(preservedWorktree), true);

    const mergedFoundation = await runGitOk(fixture.rootDir, ['show', `${summary.finalBranchName}:features/foundation.txt`]);
    const mergedFollowUp = await runGitOk(fixture.rootDir, ['show', `${summary.finalBranchName}:features/follow-up.txt`]);

    assert.match(mergedFoundation, /foundation ready on feature\/foundation-/);
    assert.match(mergedFollowUp, /follow-up built on feature\/follow-up-/);
    assert.match(mergedFollowUp, /foundation=foundation ready on feature\/foundation-/);

    assert.equal(
      events.some(event => event.type === 'boot-log' && String(event.message ?? '').includes('follow-up: waiting for foundation before starting.')),
      true
    );
  } finally {
    process.env.PATH = previousPath;
    await fixture.cleanup();
  }
});
