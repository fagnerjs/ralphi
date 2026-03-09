import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { BacklogSnapshot, BacklogStatus, ScheduleMode, SkillInstallSpec, WorkspaceStrategy } from './types.js';

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
}

export function resolvePrimaryPrdDir(rootDir: string): string {
  return path.join(rootDir, 'docs', 'prds');
}

export function resolveLegacyPrdDir(rootDir: string): string {
  return path.join(rootDir, 'prds');
}

export function resolvePrdDirCandidates(rootDir: string): string[] {
  return [resolvePrimaryPrdDir(rootDir), resolveLegacyPrdDir(rootDir)];
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  return slug || 'run';
}

export function sourceSlug(sourcePath: string): string {
  const base = slugify(path.basename(sourcePath));
  const hash = createHash('sha1').update(sourcePath).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

export function normalizeSchedule(input: string | undefined): ScheduleMode {
  const value = (input ?? '').trim().toLowerCase();
  if (!value || value === 'round-robin' || value === 'roundrobin' || value === 'round_robin') {
    return 'round-robin';
  }

  if (value === 'per-prd' || value === 'perprd' || value === 'per_prd' || value === 'sequential' || value === 'serial') {
    return 'per-prd';
  }

  if (value === 'parallel' || value === 'concurrent') {
    return 'parallel';
  }

  throw new Error(`Invalid schedule "${input}". Use "round-robin", "per-prd", or "parallel".`);
}

export function normalizeWorkspaceStrategy(input: string | undefined): WorkspaceStrategy {
  const value = (input ?? '').trim().toLowerCase();
  if (!value || value === 'worktree' || value === 'isolated' || value === 'per-prd') {
    return 'worktree';
  }

  if (value === 'shared' || value === 'single') {
    return 'shared';
  }

  throw new Error(`Invalid workspace strategy "${input}". Use "worktree" or "shared".`);
}

export async function resolveInputPath(inputPath: string, cwd: string): Promise<string> {
  const candidate = path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
  return candidate;
}

export function displayPath(targetPath: string, rootDir: string): string {
  const relative = path.relative(rootDir, targetPath);
  return relative && !relative.startsWith('..') ? relative : targetPath;
}

export function displayPathFromHome(targetPath: string, homeDir: string): string {
  if (targetPath.startsWith(homeDir)) {
    return `~/${path.relative(homeDir, targetPath)}`;
  }

  return targetPath;
}

export async function readText(targetPath: string): Promise<string> {
  return readFile(targetPath, 'utf8');
}

export async function writeJsonFile(targetPath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function parseJsonFile<T>(targetPath: string): Promise<T | null> {
  try {
    return JSON.parse(await readText(targetPath)) as T;
  } catch {
    return null;
  }
}

export async function isJsonFile(targetPath: string): Promise<boolean> {
  return (await parseJsonFile(targetPath)) !== null;
}

export async function storyProgressLabel(prdJsonPath: string): Promise<string> {
  const parsed = await parseJsonFile<{ userStories?: Array<{ passes?: boolean }> }>(prdJsonPath);
  const stories = parsed?.userStories;

  if (!stories || stories.length === 0) {
    return 'plan pending';
  }

  const completed = stories.filter(story => story.passes === true).length;
  return `${completed}/${stories.length} stories complete`;
}

export async function prdJsonComplete(prdJsonPath: string): Promise<boolean> {
  const parsed = await parseJsonFile<{ userStories?: Array<{ passes?: boolean }> }>(prdJsonPath);
  const stories = parsed?.userStories;

  return Boolean(stories && stories.length > 0 && stories.every(story => story.passes === true));
}

export async function extractJsonBranch(prdJsonPath: string): Promise<string> {
  const parsed = await parseJsonFile<{ branchName?: string }>(prdJsonPath);
  return parsed?.branchName?.trim() ?? '';
}

export function classifyOutputLine(line: string): string {
  if (line.includes('<ralphi-backlog')) return 'Updating backlog';

  const lower = line.toLowerCase();

  if (lower.includes('<promise>complete</promise>')) return 'Complete';
  if (
    lower.includes('apply_patch') ||
    lower.includes('updated the following files') ||
    lower.includes('*** update file') ||
    lower.includes('*** add file') ||
    lower.includes('*** delete file') ||
    lower.includes('created file') ||
    lower.includes('edited ')
  ) {
    return 'Editing files';
  }

  if (
    lower.includes('npm ') ||
    lower.includes('pnpm ') ||
    lower.includes('yarn ') ||
    lower.includes('bun ') ||
    lower.includes('pytest') ||
    lower.includes('typecheck') ||
    lower.includes('shellcheck') ||
    lower.includes('eslint') ||
    lower.includes('vitest') ||
    lower.includes('jest') ||
    lower.includes('go test') ||
    lower.includes('cargo test') ||
    lower.includes('bash -n')
  ) {
    return 'Running checks';
  }

  if (
    lower.includes('git diff') ||
    lower.includes('git status') ||
    lower.includes('git show') ||
    lower.includes('review')
  ) {
    return 'Reviewing changes';
  }

  if (
    lower.includes('rg ') ||
    lower.includes('find ') ||
    lower.includes('grep ') ||
    lower.includes('ls ') ||
    lower.includes('sed ') ||
    lower.includes('cat ') ||
    lower.includes('searching') ||
    lower.includes('inspect')
  ) {
    return 'Inspecting repository';
  }

  if (
    lower.includes('skill.md') ||
    lower.includes('prd.json') ||
    lower.includes('progress.txt') ||
    lower.includes('acceptance criteria') ||
    lower.includes('userstories') ||
    lower.includes('requirements') ||
    lower.includes('prd')
  ) {
    return 'Analyzing requirements';
  }

  if (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('traceback') ||
    lower.includes('exception') ||
    lower.includes('not found') ||
    lower.includes('invalid ')
  ) {
    return 'Handling an error';
  }

  return 'Agent is working';
}

export interface BacklogMarker {
  itemId: string | null;
  stepId: string | null;
  status: BacklogStatus | null;
}

export function extractBacklogMarker(line: string): BacklogMarker | null {
  const normalizedLine = line
    .split(String.raw`\u003c`).join('<')
    .split(String.raw`\u003e`).join('>')
    .split(String.raw`\"`).join('"');
  const match = normalizedLine.match(/<ralphi-backlog([^>]*)>/i);
  if (!match) {
    return null;
  }

  const attrs = match[1] ?? '';
  const read = (name: string): string | null => {
    const attrMatch = attrs.match(new RegExp(`${name}="([^"]+)"`, 'i'));
    return attrMatch?.[1] ?? null;
  };

  const status = read('status');
  const normalizedStatus =
    status === 'pending' || status === 'in_progress' || status === 'done' || status === 'blocked' || status === 'disabled'
      ? status
      : null;

  return {
    itemId: read('item'),
    stepId: read('step'),
    status: normalizedStatus
  };
}

export async function newerThan(sourcePath: string, targetPath: string): Promise<boolean> {
  const [sourceStat, targetStat] = await Promise.all([stat(sourcePath), stat(targetPath)]);
  return sourceStat.mtimeMs > targetStat.mtimeMs;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export async function findExecutable(commandName: string, envPath = process.env.PATH ?? ''): Promise<string | null> {
  const pathEntries = envPath.split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, process.platform === 'win32' ? `${commandName}${extension}` : commandName);

      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }

  return null;
}

export async function findProjectRoot(startDir: string): Promise<string> {
  let currentDir = path.resolve(startDir);

  while (true) {
    const [hasGit, hasPrimaryPrds, hasLegacyPrds, hasRalphiConfig, hasRalphiState] = await Promise.all([
      pathExists(path.join(currentDir, '.git')),
      pathExists(resolvePrimaryPrdDir(currentDir)),
      pathExists(resolveLegacyPrdDir(currentDir)),
      pathExists(path.join(currentDir, '.ralphi.json')),
      pathExists(path.join(currentDir, '.ralphi'))
    ]);

    if (hasGit || hasPrimaryPrds || hasLegacyPrds || hasRalphiConfig || hasRalphiState) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return path.resolve(startDir);
    }

    currentDir = parentDir;
  }
}

export function splitCommaList(rawValue: string): string[] {
  return rawValue
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const head = Math.max(4, Math.floor((maxLength - 1) / 2));
  const tail = Math.max(4, maxLength - head - 1);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function truncateEnd(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 1) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

export function basenameWithoutExt(targetPath: string): string {
  return path.basename(targetPath).replace(/\.[^.]+$/, '');
}

export function humanTimestamp(date = new Date()): string {
  return date.toISOString().replace('T', ' ').replace(/\..+$/, ' UTC');
}

export function repoSlug(rootDir: string): string {
  return slugify(path.basename(rootDir));
}

export function sanitizeBranchName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

export function uniqueValues<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function deriveBranchName(sourcePrd: string, prdBranchName = ''): string {
  if (prdBranchName.trim()) {
    return sanitizeBranchName(prdBranchName);
  }

  return sanitizeBranchName(`ralphi/${basenameWithoutExt(sourcePrd)}`);
}

export function ensureArrayLength(values: number[], length: number, fallback: number): number[] {
  const next = [...values];
  while (next.length < length) {
    next.push(fallback);
  }

  return next.slice(0, length);
}

export function parsePositiveIntegerList(rawValue: string | undefined): number[] {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(',')
    .map(item => Number(item.trim()))
    .filter(item => Number.isInteger(item) && item > 0);
}

export function storyLabel(count: number, total: number, label = 'stories'): string {
  return `${count}/${total} ${label}`;
}

export function backlogProgressLabel(backlog: BacklogSnapshot | null): string {
  if (!backlog) {
    return 'backlog pending';
  }

  if (backlog.totalItems === 0) {
    return backlog.items.length > 0 ? '0 active tasks' : 'backlog pending';
  }

  return `${backlog.completedItems}/${backlog.totalItems} tasks · ${backlog.completedSteps}/${backlog.totalSteps} steps`;
}

export function pickScheduleLabel(schedule: ScheduleMode): string {
  if (schedule === 'parallel') {
    return 'Parallel agents';
  }

  if (schedule === 'per-prd') {
    return 'PRD-by-PRD';
  }

  return 'Round robin';
}

export function extractPrintableInput(input: string, options: { allowNewlines?: boolean } = {}): string {
  const normalized = input.replace(/\u001b\[200~/g, '').replace(/\u001b\[201~/g, '').replace(/\r\n?/g, '\n');

  if (options.allowNewlines) {
    return normalized.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  }

  return normalized.replace(/[\u0000-\u001f\u007f]/g, '');
}

export function extractDigitInput(input: string): string {
  return extractPrintableInput(input).replace(/\D/g, '');
}

export function isPrintableInput(input: string): boolean {
  return extractPrintableInput(input).length > 0;
}

export function parseRepoPathInput(rawValue: string): { repo: string; path: string; ref?: string } {
  const trimmed = rawValue.trim();
  const githubMatch = trimmed.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+)(?:\/tree\/([^/]+)\/(.+)|\/blob\/([^/]+)\/(.+)|\/(.+))?$/
  );

  if (githubMatch) {
    const repo = githubMatch[1];
    const ref = githubMatch[2] || githubMatch[4];
    const repoPath = githubMatch[3] || githubMatch[5] || githubMatch[6];
    if (!repoPath) {
      throw new Error('The GitHub URL must point to a skill directory path.');
    }

    return { repo, path: repoPath, ref };
  }

  const shortMatch = trimmed.match(/^([^/]+\/[^/:#]+)(?::(.+))?(?:#(.+))?$/);
  if (!shortMatch) {
    throw new Error('Use owner/repo:path/to/skill or a GitHub tree URL.');
  }

  const repo = shortMatch[1];
  const repoPath = shortMatch[2];
  const ref = shortMatch[3];

  if (!repoPath) {
    throw new Error('A skill path is required after the repository name.');
  }

  return { repo, path: repoPath, ref };
}

export function summarizeSkillSource(spec: SkillInstallSpec): string {
  if (spec.source === 'codex-system') {
    return `OpenAI system · ${spec.name}`;
  }

  if (spec.source === 'codex-curated') {
    return `OpenAI catalog · ${spec.name}`;
  }

  if (spec.source === 'claude-catalog') {
    return `Anthropic catalog · ${spec.name}`;
  }

  if (spec.source === 'local') {
    return `Local project skill · ${spec.name}`;
  }

  return `${spec.repo ?? 'GitHub'}:${spec.path ?? spec.name}`;
}
