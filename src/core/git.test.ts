import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import { cleanupManagedWorktrees, gitBranchExists, runGitCommand } from './git.js';
import { loadContextCheckpoint, saveContextCheckpoint } from './session.js';
import { createTempProject, makeConfig, makeContextSnapshot, makePlan } from '../test-support.js';
import { pathExists, writeJsonFile } from './utils.js';

async function runGitOk(rootDir: string, args: string[]): Promise<string> {
  const result = await runGitCommand(rootDir, args);
  assert.equal(result.code, 0, result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

test('cleanupManagedWorktrees removes Ralphi-managed branches and worktrees even when dirty', async () => {
  const fixture = await createTempProject('ralphi-git-');

  try {
    const prdPath = path.join(fixture.rootDir, 'docs', 'prds', 'release.md');
    await writeFile(prdPath, '# PRD: Release\n', 'utf8');

    await runGitOk(fixture.rootDir, ['init', '-b', 'main']);
    await runGitOk(fixture.rootDir, ['config', 'user.name', 'Ralphi Test']);
    await runGitOk(fixture.rootDir, ['config', 'user.email', 'ralphi@example.com']);
    await runGitOk(fixture.rootDir, ['add', '.']);
    await runGitOk(fixture.rootDir, ['commit', '-m', 'chore: seed fixture']);

    const executionBranch = 'feature/ralphi-cleanup';
    const mergedBranch = 'ralphi/merged-deadbeef';
    const managedWorktreePath = path.join(fixture.rootDir, '.worktrees', 'ralphi', 'feature-ralphi-cleanup');

    await runGitOk(fixture.rootDir, ['worktree', 'add', '-b', executionBranch, managedWorktreePath, 'main']);
    await writeFile(path.join(managedWorktreePath, 'dirty-worktree.txt'), 'dirty from worktree\n', 'utf8');

    await runGitOk(fixture.rootDir, ['checkout', '-b', mergedBranch, 'main']);
    await writeFile(path.join(fixture.rootDir, 'dirty-root.txt'), 'dirty from root\n', 'utf8');

    const plan = makePlan(prdPath, {
      id: 'release',
      title: 'release',
      branchName: executionBranch,
      iterations: 1,
      stateKey: 'release'
    });
    const config = makeConfig(fixture.rootDir, {
      ralphDir: fixture.ralphDir,
      plans: [plan]
    });
    const snapshot = makeContextSnapshot(config, {
      planId: plan.id,
      sourcePrd: prdPath,
      title: 'release',
      runSlug: plan.stateKey,
      runDir: path.join(fixture.ralphDir, 'state', plan.stateKey),
      branchName: executionBranch,
      worktreePath: managedWorktreePath,
      workspaceDir: managedWorktreePath,
      status: 'blocked',
      done: false
    });

    await saveContextCheckpoint(snapshot);
    await writeJsonFile(path.join(fixture.ralphDir, 'state', 'session.json'), {
      version: 3,
      status: 'running'
    });

    const preview = await cleanupManagedWorktrees(fixture.rootDir, fixture.ralphDir, true);
    assert.equal(preview.actionable.length, 1);
    assert.equal(preview.actionableBranches.some(entry => entry.name === executionBranch), true);
    assert.equal(preview.actionableBranches.some(entry => entry.name === mergedBranch), true);

    const result = await cleanupManagedWorktrees(fixture.rootDir, fixture.ralphDir, false);

    assert.equal(result.actionable.length, 1);
    assert.equal(result.actionableBranches.length, 2);
    assert.equal(await pathExists(managedWorktreePath), false);
    assert.equal(await gitBranchExists(fixture.rootDir, executionBranch), false);
    assert.equal(await gitBranchExists(fixture.rootDir, mergedBranch), false);
    assert.equal(await pathExists(path.join(fixture.ralphDir, 'state', 'session.json')), false);
    assert.equal(await runGitOk(fixture.rootDir, ['branch', '--show-current']), 'main');

    const checkpoint = await loadContextCheckpoint(path.join(fixture.ralphDir, 'state', plan.stateKey));
    assert.equal(checkpoint?.worktreeRemoved, true);
    assert.equal(checkpoint?.branchRemoved, true);
  } finally {
    await fixture.cleanup();
  }
});
