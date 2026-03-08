import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { GitValidation, RalphConfig, RalphContextSnapshot, RalphPrdPlan, RalphTouchedFile, RalphTouchedFileChange } from './types.js';
import { deriveBranchName, displayPath, ensureDir, findExecutable, parseJsonFile, pathExists, repoSlug, sanitizeBranchName, slugify, truncateMiddle, writeJsonFile } from './utils.js';

interface GitCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  bare: boolean;
}

interface GitCommitResult {
  committed: boolean;
  commitSha: string | null;
  commitMessage: string | null;
}

interface WorkspaceFootprintEntry {
  status: string;
  change: RalphTouchedFileChange;
  digest: string | null;
}

export interface WorkspaceFootprint {
  repository: boolean;
  entries: Record<string, WorkspaceFootprintEntry>;
}

interface CheckpointWorktreeSnapshot {
  path: string;
  sourcePrd: string | null;
  status: RalphContextSnapshot['status'];
  done: boolean;
  worktreeRemoved: boolean;
}

interface CheckpointCleanupSnapshot {
  checkpointPath: string;
  runDir: string;
  path: string | null;
  branch: string | null;
  sourcePrd: string | null;
  status: RalphContextSnapshot['status'];
  done: boolean;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
}

export interface ManagedWorktreeEntry {
  path: string;
  branch: string | null;
  existsOnDisk: boolean;
  registeredWithGit: boolean;
  state: 'ok' | 'warning' | 'blocking';
  reason: string;
  sourcePrd: string | null;
  checkpointStatus: RalphContextSnapshot['status'] | null;
  done: boolean;
  worktreeRemoved: boolean;
}

export interface ManagedBranchEntry {
  name: string;
  sourcePrd: string | null;
  exists: boolean;
  reason: string;
}

export interface WorktreeCleanupResult {
  dryRun: boolean;
  entries: ManagedWorktreeEntry[];
  actionable: ManagedWorktreeEntry[];
  branches: ManagedBranchEntry[];
  actionableBranches: ManagedBranchEntry[];
}

async function runGit(rootDir: string, args: string[]): Promise<GitCommandResult> {
  return runCommand(rootDir, 'git', args);
}

export async function runGitCommand(rootDir: string, args: string[]): Promise<GitCommandResult> {
  return runGit(rootDir, args);
}

async function runCommand(rootDir: string, command: string, args: string[]): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', code => {
      resolve({
        stdout,
        stderr,
        code: code ?? 1
      });
    });
  });
}

async function gitOutput(rootDir: string, args: string[]): Promise<string> {
  const result = await runGit(rootDir, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }

  return result.stdout.trim();
}

function pathWithin(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function mapStatusToChange(status: string): RalphTouchedFileChange {
  if (status === '??') {
    return 'untracked';
  }

  if (status.includes('R')) {
    return 'renamed';
  }

  if (status.includes('A')) {
    return 'added';
  }

  if (status.includes('D')) {
    return 'deleted';
  }

  if (status.trim()) {
    return 'modified';
  }

  return 'unknown';
}

function parsePorcelainLine(line: string): { path: string; status: string; change: RalphTouchedFileChange } | null {
  if (!line.trim()) {
    return null;
  }

  const status = line.slice(0, 2);
  const remainder = line.slice(3).trim();
  if (!remainder) {
    return null;
  }

  const normalizedPath = remainder.includes(' -> ') ? remainder.split(' -> ').slice(-1)[0] : remainder;
  return {
    path: normalizedPath,
    status,
    change: mapStatusToChange(status)
  };
}

async function fileDigest(targetPath: string): Promise<string | null> {
  if (!(await pathExists(targetPath))) {
    return null;
  }

  try {
    const content = await readFile(targetPath);
    return createHash('sha1').update(content).digest('hex');
  } catch {
    return null;
  }
}

async function loadWorkspaceStatus(workspaceDir: string): Promise<Record<string, WorkspaceFootprintEntry>> {
  const result = await runGit(workspaceDir, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (result.code !== 0) {
    return {};
  }

  const entries = result.stdout
    .split(/\r?\n/)
    .map(parsePorcelainLine)
    .filter((entry): entry is { path: string; status: string; change: RalphTouchedFileChange } => Boolean(entry));

  const footprint: Record<string, WorkspaceFootprintEntry> = {};
  for (const entry of entries) {
    footprint[entry.path] = {
      status: entry.status,
      change: entry.change,
      digest: entry.change === 'deleted' ? null : await fileDigest(path.join(workspaceDir, entry.path))
    };
  }

  return footprint;
}

export async function inspectGitWorkspace(rootDir: string): Promise<GitValidation> {
  const revParse = await runGit(rootDir, ['rev-parse', '--show-toplevel']);
  if (revParse.code !== 0) {
    return {
      repository: false,
      rootDir,
      currentBranch: null,
      defaultBranch: null,
      defaultRemote: null,
      clean: true,
      dirtyEntries: [],
      warnings: ['This directory is not a Git repository. Worktrees are disabled.'],
      worktreeRoot: path.join(rootDir, '.worktrees', 'ralphi')
    };
  }

  const gitRoot = revParse.stdout.trim();
  const [currentBranchRaw, remoteHeadRaw, statusRaw] = await Promise.all([
    runGit(gitRoot, ['branch', '--show-current']),
    runGit(gitRoot, ['rev-parse', '--abbrev-ref', 'origin/HEAD']),
    runGit(gitRoot, ['status', '--porcelain=v1'])
  ]);

  const currentBranch = currentBranchRaw.code === 0 ? currentBranchRaw.stdout.trim() || null : null;
  const defaultRemote = remoteHeadRaw.code === 0 ? remoteHeadRaw.stdout.trim() : '';
  const defaultBranch = defaultRemote.includes('/') ? defaultRemote.split('/').slice(1).join('/') : null;
  const dirtyEntries = statusRaw.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const warnings: string[] = [];
  if (dirtyEntries.length > 0) {
    warnings.push('Uncommitted changes are present. Worktrees will branch from the current HEAD commit only.');
  }

  if (!currentBranch) {
    warnings.push('The repository is in detached HEAD mode. Ralphi will branch from the current commit.');
  }

  return {
    repository: true,
    rootDir: gitRoot,
    currentBranch,
    defaultBranch,
    defaultRemote: defaultRemote || null,
    clean: dirtyEntries.length === 0,
    dirtyEntries,
    warnings,
    worktreeRoot: path.join(gitRoot, '.worktrees', 'ralphi')
  };
}

export async function captureWorkspaceFootprint(workspaceDir: string): Promise<WorkspaceFootprint> {
  const revParse = await runGit(workspaceDir, ['rev-parse', '--show-toplevel']);
  if (revParse.code !== 0) {
    return {
      repository: false,
      entries: {}
    };
  }

  return {
    repository: true,
    entries: await loadWorkspaceStatus(workspaceDir)
  };
}

export function summarizeTouchedFiles(
  before: WorkspaceFootprint,
  after: WorkspaceFootprint,
  hintedPaths: string[] = []
): RalphTouchedFile[] {
  const allPaths = new Set<string>([
    ...Object.keys(before.entries),
    ...Object.keys(after.entries),
    ...hintedPaths.map(entry => entry.trim()).filter(Boolean)
  ]);
  const touched: RalphTouchedFile[] = [];

  for (const filePath of allPaths) {
    const previous = before.entries[filePath];
    const current = after.entries[filePath];

    if (!previous && !current) {
      touched.push({
        path: filePath,
        change: 'unknown'
      });
      continue;
    }

    if (!previous || !current || previous.status !== current.status || previous.digest !== current.digest) {
      touched.push({
        path: filePath,
        change: current?.change ?? previous?.change ?? 'unknown'
      });
    }
  }

  return touched.sort((left, right) => left.path.localeCompare(right.path));
}

export function extractTouchedFileHints(output: string): string[] {
  const hints = new Set<string>();
  const patterns = [
    /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm,
    /^\s*[-*]\s+([A-Za-z0-9_./-]+\.[A-Za-z0-9._-]+)\s*$/gm
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      const value = match[1]?.trim();
      if (value) {
        hints.add(value);
      }
    }
  }

  return Array.from(hints).sort((left, right) => left.localeCompare(right));
}

async function parseWorktreeList(rootDir: string): Promise<WorktreeEntry[]> {
  const result = await runGit(rootDir, ['worktree', 'list', '--porcelain']);
  if (result.code !== 0) {
    return [];
  }

  const entries: WorktreeEntry[] = [];
  const lines = result.stdout.split(/\r?\n/);
  let current: WorktreeEntry | null = null;

  for (const line of lines) {
    if (!line.trim()) {
      if (current) {
        entries.push(current);
      }
      current = null;
      continue;
    }

    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ').trim();

    if (key === 'worktree') {
      current = {
        path: value,
        branch: null,
        bare: false
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (key === 'branch') {
      current.branch = value.replace('refs/heads/', '');
    } else if (key === 'bare') {
      current.bare = true;
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

async function listManagedWorktreeDirs(worktreeRoot: string): Promise<string[]> {
  if (!(await pathExists(worktreeRoot))) {
    return [];
  }

  const entries = await readdir(worktreeRoot, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(worktreeRoot, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function repairWorktreePath(rootDir: string, worktreePath: string): Promise<WorktreeEntry | null> {
  const repairResult = await runGit(rootDir, ['worktree', 'repair', worktreePath]);
  if (repairResult.code !== 0) {
    return null;
  }

  const refreshed = await parseWorktreeList(rootDir);
  return refreshed.find(entry => entry.path === worktreePath) ?? null;
}

async function moveManagedWorktreeAside(worktreePath: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let candidate = `${worktreePath}-orphaned-${stamp}`;
  let suffix = 2;

  while (await pathExists(candidate)) {
    candidate = `${worktreePath}-orphaned-${stamp}-${suffix}`;
    suffix += 1;
  }

  await rename(worktreePath, candidate);
  return candidate;
}

export async function gitBranchExists(rootDir: string, branchName: string): Promise<boolean> {
  const result = await runGit(rootDir, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
  return result.code === 0;
}

async function listLocalBranches(rootDir: string): Promise<string[]> {
  const result = await runGit(rootDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

async function switchRootWorkspaceAwayFromManagedBranches(
  validation: GitValidation,
  branchNames: Set<string>
): Promise<void> {
  if (!validation.currentBranch || !branchNames.has(validation.currentBranch)) {
    return;
  }

  const localBranches = await listLocalBranches(validation.rootDir);
  const branchCandidates = [validation.defaultBranch, 'main', 'master', ...localBranches].filter(
    (branchName): branchName is string => Boolean(branchName)
  );
  const safeBranch = branchCandidates.find(branchName => branchName !== validation.currentBranch && !branchNames.has(branchName));

  if (safeBranch) {
    const switchResult = await runGit(validation.rootDir, ['checkout', '-f', safeBranch]);
    if (switchResult.code !== 0) {
      throw new Error(switchResult.stderr.trim() || switchResult.stdout.trim() || `Unable to switch to ${safeBranch} before cleanup.`);
    }
    return;
  }

  const detachResult = await runGit(validation.rootDir, ['checkout', '--detach', '-f', 'HEAD']);
  if (detachResult.code !== 0) {
    throw new Error(detachResult.stderr.trim() || detachResult.stdout.trim() || 'Unable to detach HEAD before cleanup.');
  }
}

function collectManagedBranches(
  localBranches: string[],
  gitEntries: WorktreeEntry[],
  checkpoints: CheckpointCleanupSnapshot[]
): ManagedBranchEntry[] {
  const existingBranches = new Set(localBranches);
  const branches = new Map<string, ManagedBranchEntry>();

  const remember = (name: string | null | undefined, sourcePrd: string | null, reason: string) => {
    if (!name) {
      return;
    }

    const current = branches.get(name);
    branches.set(name, {
      name,
      sourcePrd: current?.sourcePrd ?? sourcePrd,
      exists: existingBranches.has(name),
      reason: current?.reason ?? reason
    });
  };

  for (const entry of gitEntries) {
    if (entry.branch) {
      remember(entry.branch, null, 'Execution branch attached to a managed Ralphi worktree.');
    }
  }

  for (const checkpoint of checkpoints) {
    if (!checkpoint.branch || checkpoint.branchRemoved) {
      continue;
    }

    remember(
      checkpoint.branch,
      checkpoint.sourcePrd,
      checkpoint.done
        ? 'Execution branch retained after a previous Ralphi run.'
        : 'Execution branch still referenced by a saved Ralphi checkpoint.'
    );
  }

  for (const branchName of localBranches) {
    if (!branchName.startsWith('ralphi/merged-')) {
      continue;
    }

    remember(branchName, null, 'Final merged branch created by Ralphi.');
  }

  return Array.from(branches.values()).sort((left, right) => left.name.localeCompare(right.name));
}

async function markManagedCleanupState(
  rootDir: string,
  managedRoot: string,
  checkpoints: CheckpointCleanupSnapshot[],
  removedWorktrees: Set<string>,
  removedBranches: Set<string>
): Promise<void> {
  for (const checkpoint of checkpoints) {
    const snapshot = await parseJsonFile<RalphContextSnapshot>(checkpoint.checkpointPath);
    if (!snapshot) {
      continue;
    }

    let changed = false;
    if (snapshot.worktreePath && pathWithin(snapshot.worktreePath, managedRoot)) {
      if (!snapshot.worktreeRemoved || removedWorktrees.has(snapshot.worktreePath)) {
        snapshot.worktreeRemoved = true;
        changed = true;
      }
    }

    if (snapshot.branchName) {
      const belongsToManagedRun = removedBranches.has(snapshot.branchName) || Boolean(snapshot.worktreePath && pathWithin(snapshot.worktreePath, managedRoot));
      if (belongsToManagedRun && !snapshot.branchRemoved) {
        snapshot.branchRemoved = true;
        changed = true;
      }
    }

    if (changed) {
      if (snapshot.worktreeRemoved && snapshot.workspaceDir === snapshot.worktreePath) {
        snapshot.workspaceDir = rootDir;
      }
      await writeJsonFile(checkpoint.checkpointPath, snapshot);
    }
  }
}

function worktreeName(plan: RalphPrdPlan): string {
  return slugify(plan.branchName ?? plan.title);
}

function worktreeNameFromSnapshot(context: RalphContextSnapshot, branchName: string): string {
  return slugify(branchName || context.title || context.sourceLabel);
}

function normalizeCommitSubject(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[.:]+$/g, '').trim();
}

function buildTaskCommitMessage(sourcePrd: string, title: string): string {
  const fallback = path.basename(sourcePrd).replace(/\.[^.]+$/, '');
  const label = normalizeCommitSubject(title.trim() || fallback) || fallback;
  return `chore(ralphi): complete ${label}`;
}

function resolveBranchName(plan: RalphPrdPlan, takenBranches: Set<string>): string {
  const base = sanitizeBranchName(plan.branchName ?? deriveBranchName(plan.sourcePrd));
  if (!takenBranches.has(base)) {
    takenBranches.add(base);
    return base;
  }

  let index = 2;
  while (takenBranches.has(`${base}-${index}`)) {
    index += 1;
  }

  const next = `${base}-${index}`;
  takenBranches.add(next);
  return next;
}

export async function provisionWorktrees(
  config: RalphConfig,
  contexts: RalphContextSnapshot[],
  validation: GitValidation,
  reporter?: (message: string, contextIndex?: number) => Promise<void> | void
): Promise<void> {
  if (config.workspaceStrategy === 'shared' || !validation.repository) {
    return;
  }

  await ensureDir(validation.worktreeRoot);
  await runGit(validation.rootDir, ['worktree', 'prune']);
  let existing = await parseWorktreeList(validation.rootDir);
  const takenBranches = new Set(existing.map(entry => entry.branch).filter((entry): entry is string => Boolean(entry)));

  for (const context of contexts) {
    const desiredBranch = resolveBranchName(
      {
        id: context.planId,
        stateKey: context.runSlug,
        variantIndex: null,
        variantCount: null,
        title: context.title,
        sourcePrd: context.sourcePrd,
        iterations: context.iterationsTarget,
        branchName: context.branchName,
        baseRef: context.baseRef,
        worktreePath: context.worktreePath,
        backlogPath: context.backlogPath,
        resetBacklog: false,
        dependsOn: null
      },
      takenBranches
    );
    const worktreePath = path.join(validation.worktreeRoot, worktreeNameFromSnapshot(context, desiredBranch));
    const existingByBranch = existing.find(entry => entry.branch === desiredBranch);
    const directoryExists = await pathExists(worktreePath);

    context.branchName = desiredBranch;
    context.baseRef = context.baseRef || validation.currentBranch || validation.defaultBranch || 'HEAD';
    context.worktreePath = worktreePath;
    context.workspaceDir = worktreePath;

    if (existingByBranch) {
      if (!(await pathExists(existingByBranch.path))) {
        await reporter?.(
          `Detected stale worktree metadata for ${desiredBranch}. Pruning the registry before retrying.`,
          context.index
        );
        await runGit(validation.rootDir, ['worktree', 'prune']);
        existing = await parseWorktreeList(validation.rootDir);
      } else {
        context.worktreePath = existingByBranch.path;
        context.workspaceDir = existingByBranch.path;
        await reporter?.(`Reusing worktree ${displayPath(existingByBranch.path, validation.rootDir)} on ${desiredBranch}.`, context.index);
        continue;
      }
    }

    const refreshedByBranch = existing.find(entry => entry.branch === desiredBranch);
    const refreshedByPath = existing.find(entry => entry.path === worktreePath);
    if (refreshedByBranch) {
      context.worktreePath = refreshedByBranch.path;
      context.workspaceDir = refreshedByBranch.path;
      await reporter?.(`Reusing worktree ${displayPath(refreshedByBranch.path, validation.rootDir)} on ${desiredBranch}.`, context.index);
      continue;
    }

    if (refreshedByPath) {
      context.workspaceDir = refreshedByPath.path;
      await reporter?.(`Reusing worktree path ${displayPath(refreshedByPath.path, validation.rootDir)}.`, context.index);
      continue;
    }

    if (directoryExists) {
      await reporter?.(
        `Found an existing managed directory at ${displayPath(worktreePath, validation.rootDir)}. Attempting repair before recreating it.`,
        context.index
      );

      const repaired = await repairWorktreePath(validation.rootDir, worktreePath);
      if (repaired) {
        existing = await parseWorktreeList(validation.rootDir);
        context.worktreePath = repaired.path;
        context.workspaceDir = repaired.path;
        context.branchName = repaired.branch ?? context.branchName;
        await reporter?.(
          `Recovered the existing worktree ${displayPath(repaired.path, validation.rootDir)}${repaired.branch ? ` on ${repaired.branch}` : ''}.`,
          context.index
        );
        continue;
      }

      const preservedPath = await moveManagedWorktreeAside(worktreePath);
      await reporter?.(
        `Moved orphaned managed directory to ${displayPath(preservedPath, validation.rootDir)} so Ralphi can recreate ${displayPath(worktreePath, validation.rootDir)}.`,
        context.index
      );
    }

    const branchAlreadyExists = await gitBranchExists(validation.rootDir, desiredBranch);
    const args = branchAlreadyExists
      ? ['worktree', 'add', worktreePath, desiredBranch]
      : ['worktree', 'add', '-b', desiredBranch, worktreePath, context.baseRef];
    const result = await runGit(validation.rootDir, args);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `Unable to create worktree for ${context.sourceLabel}.`);
    }

    await reporter?.(
      `Created ${displayPath(worktreePath, validation.rootDir)} from ${context.baseRef} on ${desiredBranch}.`,
      context.index
    );
  }
}

export async function commitWorkspaceChanges(options: {
  workspaceDir: string;
  sourcePrd: string;
  title: string;
}): Promise<GitCommitResult> {
  const statusBefore = await runGit(options.workspaceDir, ['status', '--porcelain=v1']);
  if (statusBefore.code !== 0) {
    throw new Error(statusBefore.stderr.trim() || 'Unable to inspect workspace changes before commit.');
  }

  if (!statusBefore.stdout.trim()) {
    return {
      committed: false,
      commitSha: null,
      commitMessage: null
    };
  }

  const addResult = await runGit(options.workspaceDir, ['add', '-A']);
  if (addResult.code !== 0) {
    throw new Error(addResult.stderr.trim() || 'Unable to stage workspace changes.');
  }

  const commitMessage = buildTaskCommitMessage(options.sourcePrd, options.title);
  const commitResult = await runGit(options.workspaceDir, ['commit', '-m', commitMessage]);
  if (commitResult.code !== 0) {
    throw new Error(commitResult.stderr.trim() || commitResult.stdout.trim() || 'Unable to create the task commit.');
  }

  return {
    committed: true,
    commitSha: await gitOutput(options.workspaceDir, ['rev-parse', 'HEAD']),
    commitMessage
  };
}

export async function removeGitBranch(rootDir: string, branchName: string): Promise<void> {
  if (!(await gitBranchExists(rootDir, branchName))) {
    return;
  }

  const deleteResult = await runGit(rootDir, ['branch', '-D', branchName]);
  if (deleteResult.code !== 0) {
    throw new Error(deleteResult.stderr.trim() || deleteResult.stdout.trim() || `Unable to remove branch ${branchName}.`);
  }
}

export async function removeGitWorktree(rootDir: string, worktreePath: string): Promise<void> {
  if (!(await pathExists(worktreePath))) {
    return;
  }

  const removeResult = await runGit(rootDir, ['worktree', 'remove', '--force', worktreePath]);
  if (removeResult.code !== 0) {
    throw new Error(removeResult.stderr.trim() || `Unable to remove worktree ${displayPath(worktreePath, rootDir)}.`);
  }

  await runGit(rootDir, ['worktree', 'prune']);
}

async function readCheckpointSnapshots(ralphDir: string): Promise<CheckpointCleanupSnapshot[]> {
  const stateDir = path.join(ralphDir, 'state');
  if (!(await pathExists(stateDir))) {
    return [];
  }

  const entries = await readdir(stateDir, { withFileTypes: true });
  const checkpoints: Array<CheckpointCleanupSnapshot | null> = await Promise.all(
    entries
      .filter(entry => entry.isDirectory())
      .map(async entry => {
        const checkpointPath = path.join(stateDir, entry.name, 'checkpoint.json');
        const checkpoint = await parseJsonFile<RalphContextSnapshot>(checkpointPath);
        if (!checkpoint) {
          return null;
        }

        return {
          checkpointPath,
          runDir: path.join(stateDir, entry.name),
          path: checkpoint.worktreePath ?? null,
          branch: checkpoint.branchName ?? null,
          sourcePrd: checkpoint.sourcePrd ?? null,
          status: checkpoint.status,
          done: checkpoint.done,
          worktreeRemoved: checkpoint.worktreeRemoved,
          branchRemoved: checkpoint.branchRemoved
        } satisfies CheckpointCleanupSnapshot;
      })
  );

  return checkpoints.filter((entry): entry is CheckpointCleanupSnapshot => Boolean(entry));
}

async function readCheckpointWorktrees(ralphDir: string, managedRoot: string): Promise<CheckpointWorktreeSnapshot[]> {
  const checkpoints = await readCheckpointSnapshots(ralphDir);
  return checkpoints
    .filter((checkpoint): checkpoint is CheckpointCleanupSnapshot & { path: string } => checkpoint.path !== null && pathWithin(checkpoint.path, managedRoot))
    .map(checkpoint => ({
      path: checkpoint.path,
      sourcePrd: checkpoint.sourcePrd,
      status: checkpoint.status,
      done: checkpoint.done,
      worktreeRemoved: checkpoint.worktreeRemoved
    }));
}

function buildManagedWorktreeEntry(
  worktreePath: string,
  gitEntry: WorktreeEntry | null,
  checkpoint: CheckpointWorktreeSnapshot | null,
  existsOnDisk: boolean
): ManagedWorktreeEntry {
  const targetPath = gitEntry?.path ?? checkpoint?.path ?? worktreePath;

  if (!gitEntry && checkpoint?.worktreeRemoved && !existsOnDisk) {
    return {
      path: targetPath,
      branch: null,
      existsOnDisk,
      registeredWithGit: false,
      state: 'ok',
      reason: 'Checkpoint already marks this worktree as removed.',
      sourcePrd: checkpoint.sourcePrd,
      checkpointStatus: checkpoint.status,
      done: checkpoint.done,
      worktreeRemoved: checkpoint.worktreeRemoved
    };
  }

  if (gitEntry && existsOnDisk && checkpoint && !checkpoint.worktreeRemoved && !checkpoint.done) {
    return {
      path: gitEntry.path,
      branch: gitEntry.branch,
      existsOnDisk,
      registeredWithGit: true,
      state: 'ok',
      reason: 'Active Ralphi worktree.',
      sourcePrd: checkpoint.sourcePrd,
      checkpointStatus: checkpoint.status,
      done: checkpoint.done,
      worktreeRemoved: checkpoint.worktreeRemoved
    };
  }

  if (gitEntry && !existsOnDisk) {
    return {
      path: gitEntry.path,
      branch: gitEntry.branch,
      existsOnDisk,
      registeredWithGit: true,
      state: 'blocking',
      reason: 'Git still tracks this managed worktree path, but the directory is missing on disk.',
      sourcePrd: checkpoint?.sourcePrd ?? null,
      checkpointStatus: checkpoint?.status ?? null,
      done: checkpoint?.done ?? false,
      worktreeRemoved: checkpoint?.worktreeRemoved ?? false
    };
  }

  if (checkpoint?.worktreeRemoved && existsOnDisk) {
    return {
      path: targetPath,
      branch: gitEntry?.branch ?? null,
      existsOnDisk,
      registeredWithGit: Boolean(gitEntry),
      state: 'warning',
      reason: 'Checkpoint says cleanup finished, but the managed directory still exists.',
      sourcePrd: checkpoint.sourcePrd,
      checkpointStatus: checkpoint.status,
      done: checkpoint.done,
      worktreeRemoved: checkpoint.worktreeRemoved
    };
  }

  if (checkpoint?.done && existsOnDisk) {
    return {
      path: targetPath,
      branch: gitEntry?.branch ?? null,
      existsOnDisk,
      registeredWithGit: Boolean(gitEntry),
      state: 'warning',
      reason: 'The PRD is complete, but the managed worktree was not cleaned up.',
      sourcePrd: checkpoint.sourcePrd,
      checkpointStatus: checkpoint.status,
      done: checkpoint.done,
      worktreeRemoved: checkpoint.worktreeRemoved
    };
  }

  if (gitEntry && existsOnDisk && !checkpoint) {
    return {
      path: gitEntry.path,
      branch: gitEntry.branch,
      existsOnDisk,
      registeredWithGit: true,
      state: 'warning',
      reason: 'Managed worktree exists without a matching checkpoint in .ralphi/state.',
      sourcePrd: null,
      checkpointStatus: null,
      done: false,
      worktreeRemoved: false
    };
  }

  if (!gitEntry && existsOnDisk) {
    return {
      path: targetPath,
      branch: null,
      existsOnDisk,
      registeredWithGit: false,
      state: checkpoint && !checkpoint.done ? 'blocking' : 'warning',
      reason: checkpoint && !checkpoint.done
        ? 'Checkpoint still points to this worktree, but Git no longer tracks it.'
        : 'Orphaned directory inside the managed Ralphi worktree root.',
      sourcePrd: checkpoint?.sourcePrd ?? null,
      checkpointStatus: checkpoint?.status ?? null,
      done: checkpoint?.done ?? false,
      worktreeRemoved: checkpoint?.worktreeRemoved ?? false
    };
  }

  return {
    path: targetPath,
    branch: gitEntry?.branch ?? null,
    existsOnDisk,
    registeredWithGit: Boolean(gitEntry),
    state: 'warning',
    reason: 'Managed worktree metadata is inconsistent.',
    sourcePrd: checkpoint?.sourcePrd ?? null,
    checkpointStatus: checkpoint?.status ?? null,
    done: checkpoint?.done ?? false,
    worktreeRemoved: checkpoint?.worktreeRemoved ?? false
  };
}

export async function inspectManagedWorktrees(rootDir: string, ralphDir: string): Promise<ManagedWorktreeEntry[]> {
  const validation = await inspectGitWorkspace(rootDir);
  if (!validation.repository) {
    return [];
  }

  const [gitEntries, checkpoints, managedDirs] = await Promise.all([
    parseWorktreeList(validation.rootDir),
    readCheckpointWorktrees(ralphDir, validation.worktreeRoot),
    listManagedWorktreeDirs(validation.worktreeRoot)
  ]);

  const managedGitEntries = gitEntries.filter(entry => pathWithin(entry.path, validation.worktreeRoot));
  const pathSet = new Set<string>([
    ...managedGitEntries.map(entry => entry.path),
    ...checkpoints.map(entry => entry.path),
    ...managedDirs
  ]);

  const result = await Promise.all(
    Array.from(pathSet)
      .sort((left, right) => left.localeCompare(right))
      .map(async worktreePath =>
        buildManagedWorktreeEntry(
          worktreePath,
          managedGitEntries.find(entry => entry.path === worktreePath) ?? null,
          checkpoints.find(entry => entry.path === worktreePath) ?? null,
          await pathExists(worktreePath)
        )
      )
  );

  return result;
}

function cleanupCandidate(entry: ManagedWorktreeEntry): boolean {
  if (!entry.existsOnDisk && entry.registeredWithGit) {
    return true;
  }

  if (!entry.existsOnDisk) {
    return false;
  }

  if (entry.checkpointStatus === 'running' || entry.checkpointStatus === 'queued' || entry.checkpointStatus === 'booting') {
    return false;
  }

  if (entry.checkpointStatus === 'blocked' && !entry.done && !entry.worktreeRemoved) {
    return false;
  }

  return entry.state !== 'ok';
}

export async function cleanupManagedWorktrees(
  rootDir: string,
  ralphDir: string,
  dryRun = true
): Promise<WorktreeCleanupResult> {
  const validation = await inspectGitWorkspace(rootDir);
  if (!validation.repository) {
    return {
      dryRun,
      entries: [],
      actionable: [],
      branches: [],
      actionableBranches: []
    };
  }

  const [entries, checkpoints, gitEntries, localBranches] = await Promise.all([
    inspectManagedWorktrees(rootDir, ralphDir),
    readCheckpointSnapshots(ralphDir),
    parseWorktreeList(validation.rootDir),
    listLocalBranches(validation.rootDir)
  ]);
  const managedGitEntries = gitEntries.filter(entry => pathWithin(entry.path, validation.worktreeRoot));
  const actionable = entries.filter(entry => entry.existsOnDisk || entry.registeredWithGit);
  const branches = collectManagedBranches(localBranches, managedGitEntries, checkpoints);
  const actionableBranches = branches.filter(entry => entry.exists);

  if (!dryRun) {
    const removedWorktrees = new Set<string>();
    for (const entry of actionable) {
      if (entry.existsOnDisk && entry.registeredWithGit) {
        await removeGitWorktree(validation.rootDir, entry.path).catch(async () => {
          await rm(entry.path, { recursive: true, force: true });
        });
        removedWorktrees.add(entry.path);
        continue;
      }

      if (entry.existsOnDisk) {
        await rm(entry.path, { recursive: true, force: true });
        removedWorktrees.add(entry.path);
      }
    }

    await runGit(validation.rootDir, ['worktree', 'prune']);

    const removedBranches = new Set(actionableBranches.map(entry => entry.name));
    if (removedBranches.size > 0) {
      await switchRootWorkspaceAwayFromManagedBranches(validation, removedBranches);
      for (const entry of actionableBranches) {
        await removeGitBranch(validation.rootDir, entry.name);
      }
    }

    await markManagedCleanupState(validation.rootDir, validation.worktreeRoot, checkpoints, removedWorktrees, removedBranches);
    await rm(path.join(ralphDir, 'state', 'session.json'), { force: true });
  }

  return {
    dryRun,
    entries,
    actionable,
    branches,
    actionableBranches
  };
}

export async function withGitHubSparseCheckout<T>(
  repo: string,
  repoPaths: string[],
  ref = 'main',
  reader: (checkoutDir: string) => Promise<T>
): Promise<T> {
  const sparsePaths = Array.from(
    new Set(
      repoPaths
        .map(entry => entry.trim())
        .filter(Boolean)
    )
  );

  if (sparsePaths.length === 0) {
    throw new Error('At least one repository path is required for sparse checkout.');
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'ralphi-skill-'));

  try {
    const clone = await runGit(process.cwd(), [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      `https://github.com/${repo}.git`,
      scratch
    ]);

    if (clone.code !== 0) {
      throw new Error(clone.stderr.trim() || `Unable to clone ${repo}.`);
    }

    const sparseInit = await runGit(scratch, ['sparse-checkout', 'init', '--cone']);
    if (sparseInit.code !== 0) {
      throw new Error(sparseInit.stderr.trim() || 'Unable to initialize sparse checkout.');
    }

    const sparseSet = await runGit(scratch, ['sparse-checkout', 'set', ...sparsePaths]);
    if (sparseSet.code !== 0) {
      throw new Error(sparseSet.stderr.trim() || `Unable to checkout ${sparsePaths.join(', ')}.`);
    }

    const checkout = await runGit(scratch, ['checkout', ref]);
    if (checkout.code !== 0) {
      throw new Error(checkout.stderr.trim() || `Unable to checkout ${ref}.`);
    }

    return await reader(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function createSkillFromGitHub(
  targetDir: string,
  repo: string,
  repoPath: string,
  ref = 'main'
): Promise<void> {
  await withGitHubSparseCheckout(repo, [repoPath], ref, async scratch => {
    const sourceDir = path.join(scratch, repoPath);
    if (!(await pathExists(sourceDir))) {
      throw new Error(`The repository path ${repoPath} does not exist in ${repo}@${ref}.`);
    }

    const skillFile = path.join(sourceDir, 'SKILL.md');
    if (!(await pathExists(skillFile))) {
      throw new Error(`The repository path ${repoPath} is not a skill folder.`);
    }

    await rm(targetDir, { recursive: true, force: true });
    await mkdir(path.dirname(targetDir), { recursive: true });
    await cp(sourceDir, targetDir, { recursive: true, force: true });
  });
}

export async function readSkillFrontmatter(skillDir: string): Promise<{ name: string; description: string }> {
  const skillFile = path.join(skillDir, 'SKILL.md');
  const content = await readFile(skillFile, 'utf8');
  const lines = content.split('\n').slice(0, 24);
  const read = (field: 'name' | 'description') =>
    lines
      .find(line => line.trim().startsWith(`${field}:`))
      ?.split(':')
      .slice(1)
      .join(':')
      .trim()
      .replace(/^"+|"+$/g, '') ?? '';

  return {
    name: read('name') || path.basename(skillDir),
    description: truncateMiddle(read('description') || 'No description provided.', 120)
  };
}

export async function createGitPullRequest(options: {
  repoDir: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
  remoteName?: string | null;
}): Promise<string> {
  const ghExecutable = await findExecutable('gh');
  if (!ghExecutable) {
    throw new Error('GitHub CLI (`gh`) was not found in PATH.');
  }

  const branchName = options.branchName.trim();
  if (!branchName) {
    throw new Error('This context does not have a branch name for PR creation.');
  }

  const remoteName = options.remoteName?.trim() || 'origin';
  const pushResult = await runGit(options.repoDir, ['push', remoteName, `refs/heads/${branchName}:refs/heads/${branchName}`]);
  if (pushResult.code !== 0) {
    throw new Error(pushResult.stderr.trim() || pushResult.stdout.trim() || `Unable to push ${branchName}.`);
  }

  const createResult = await runCommand(options.repoDir, ghExecutable, [
    'pr',
    'create',
    '--base',
    options.baseBranch,
    '--head',
    branchName,
    '--title',
    options.title,
    '--body',
    options.body
  ]);

  if (createResult.code === 0) {
    return createResult.stdout.trim() || `PR created for ${branchName}.`;
  }

  const existingResult = await runCommand(options.repoDir, ghExecutable, [
    'pr',
    'list',
    '--head',
    branchName,
    '--json',
    'url',
    '--limit',
    '1',
    '--jq',
    '.[0].url'
  ]);

  if (existingResult.code === 0 && existingResult.stdout.trim()) {
    return existingResult.stdout.trim();
  }

  throw new Error(createResult.stderr.trim() || createResult.stdout.trim() || `Unable to create a PR for ${branchName}.`);
}
