import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { withGitHubSparseCheckout } from './git.js';
import type { SkillInstallSpec, SkillSourceKind } from './types.js';
import { pathExists } from './utils.js';

export interface CatalogSkillEntry {
  id: string;
  name: string;
  repo: string;
  path: string;
  ref: string;
  source: SkillSourceKind;
  description: string;
  catalogLabel: string;
  target: 'codex' | 'claude';
}

export interface CatalogSkillPreview {
  entry: CatalogSkillEntry;
  content: string;
  requirements: string[];
  files: string[];
}

const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';
const DEFAULT_REF = 'main';

let githubApiRateLimited = false;

const repoTreeCache = new Map<string, Promise<GitHubTreeEntry[] | null>>();
const repoTextCache = new Map<string, Promise<string>>();

interface GitHubTreeEntry {
  path: string;
  type: 'blob' | 'tree';
}

interface CatalogRepoSpec {
  rootPath: string;
  source: SkillSourceKind;
  target: 'codex' | 'claude';
  catalogLabel: string;
  maxDepth: number;
}

class GitHubApiError extends Error {
  status: number;
  details: string;

  constructor(status: number, message: string, details = '') {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.details = details;
  }
}

async function githubJson<T>(resource: string): Promise<T> {
  const response = await fetch(`${GITHUB_API}${resource}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ralphi'
    }
  });

  if (!response.ok) {
    const body = await response.text();
    let details = body.trim();

    if (body) {
      try {
        const parsed = JSON.parse(body) as { message?: string };
        if (typeof parsed.message === 'string' && parsed.message.trim()) {
          details = parsed.message.trim();
        }
      } catch {
        details = body.trim();
      }
    }

    const statusDetail = details || response.statusText || 'Request failed';
    throw new GitHubApiError(response.status, `GitHub API request failed: ${response.status} ${statusDetail}`, details);
  }

  return (await response.json()) as T;
}

function isGitHubRateLimitError(error: unknown): error is GitHubApiError {
  return (
    error instanceof GitHubApiError &&
    error.status === 403 &&
    /rate limit/i.test(`${error.message} ${error.details}`.trim())
  );
}

function rawGitHubUrl(repo: string, filePath: string, ref = DEFAULT_REF): string {
  const normalizedRef = encodeURIComponent(ref).replace(/%2F/g, '/');
  const normalizedPath = filePath
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');

  return `${GITHUB_RAW}/${repo}/${normalizedRef}/${normalizedPath}`;
}

async function downloadText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ralphi'
    }
  });

  if (!response.ok) {
    throw new Error(`Unable to download ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function readRepoText(repo: string, filePath: string, ref = DEFAULT_REF): Promise<string> {
  const cacheKey = `${repo}@${ref}:${filePath}`;
  const cached = repoTextCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = downloadText(rawGitHubUrl(repo, filePath, ref));
  repoTextCache.set(cacheKey, pending);

  try {
    return await pending;
  } catch (error) {
    repoTextCache.delete(cacheKey);
    throw error;
  }
}

function readFrontmatterField(content: string, field: string): string {
  const line = content
    .split('\n')
    .slice(0, 40)
    .find(entry => entry.trim().startsWith(`${field}:`));

  if (!line) {
    return '';
  }

  return line
    .split(':')
    .slice(1)
    .join(':')
    .trim()
    .replace(/^"+|"+$/g, '');
}

function extractRequirementsSection(content: string): string[] {
  const lines = content.split('\n');
  const startIndex = lines.findIndex(line => /^##+\s+(requirements|prerequisites)\b/i.test(line.trim()));
  if (startIndex === -1) {
    return [];
  }

  const requirements: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^##+\s+/.test(trimmed)) {
      break;
    }

    requirements.push(trimmed.replace(/^[-*]\s*/, ''));
  }

  return requirements;
}

function fileBasedRequirements(files: string[]): string[] {
  const requirements: string[] = [];

  if (files.includes('package.json')) {
    requirements.push('Node.js dependencies declared in package.json.');
  }
  if (files.includes('pnpm-lock.yaml')) {
    requirements.push('pnpm is expected by the skill package lockfile.');
  }
  if (files.includes('requirements.txt') || files.includes('pyproject.toml')) {
    requirements.push('Python dependencies are declared for this skill.');
  }
  if (files.includes('go.mod')) {
    requirements.push('Go tooling is required by this skill.');
  }
  if (files.includes('Cargo.toml')) {
    requirements.push('Rust tooling is required by this skill.');
  }
  if (files.includes('Dockerfile') || files.includes('docker-compose.yml') || files.includes('docker-compose.yaml')) {
    requirements.push('Docker is referenced by this skill package.');
  }

  return requirements;
}

function inferRequirements(content: string, files: string[]): string[] {
  const requirements = [
    ...extractRequirementsSection(content),
    ...fileBasedRequirements(files)
  ];

  const allowedTools = readFrontmatterField(content, 'allowed-tools');
  if (allowedTools) {
    requirements.push(`Allowed tools: ${allowedTools}`);
  }

  const unique = Array.from(new Set(requirements.map(entry => entry.trim()).filter(Boolean)));
  return unique.length > 0 ? unique : ['No explicit requirements were declared. Review SKILL.md before installing.'];
}

async function readDescription(repo: string, skillPath: string, ref = DEFAULT_REF): Promise<string> {
  const skillFilePath = path.posix.join(skillPath, 'SKILL.md');
  const content = await readRepoText(repo, skillFilePath, ref).catch(() => '');
  return readFrontmatterField(content, 'description') || 'No description available.';
}

function sortCatalogEntries(entries: CatalogSkillEntry[]): CatalogSkillEntry[] {
  return entries.sort((left, right) =>
    left.catalogLabel === right.catalogLabel ? left.name.localeCompare(right.name) : left.catalogLabel.localeCompare(right.catalogLabel)
  );
}

function relativeDepth(rootPath: string, candidatePath: string): number | null {
  if (candidatePath === rootPath) {
    return 0;
  }

  const relative = path.posix.relative(rootPath, candidatePath);
  if (!relative || relative.startsWith('..')) {
    return null;
  }

  return relative.split('/').filter(Boolean).length;
}

function listSkillPathsFromTree(tree: GitHubTreeEntry[], spec: CatalogRepoSpec): string[] {
  const skillPaths = new Set<string>();

  for (const entry of tree) {
    if (entry.type !== 'blob' || !entry.path.endsWith('/SKILL.md')) {
      continue;
    }

    const skillPath = path.posix.dirname(entry.path);
    const depth = relativeDepth(spec.rootPath, skillPath);
    if (depth === null || depth > spec.maxDepth) {
      continue;
    }

    skillPaths.add(skillPath);
  }

  return Array.from(skillPaths).sort((left, right) => left.localeCompare(right));
}

function listFolderFilesFromTree(tree: GitHubTreeEntry[], skillPath: string): string[] {
  return tree
    .filter(entry => entry.type === 'blob' && entry.path.startsWith(`${skillPath}/`))
    .map(entry => entry.path.slice(skillPath.length + 1))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

async function getRepoTree(repo: string, ref = DEFAULT_REF): Promise<GitHubTreeEntry[] | null> {
  if (githubApiRateLimited) {
    return null;
  }

  const cacheKey = `${repo}@${ref}`;
  const cached = repoTreeCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    try {
      const result = await githubJson<{ tree?: GitHubTreeEntry[] }>(
        `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`
      );
      return result.tree ?? [];
    } catch (error) {
      if (isGitHubRateLimitError(error)) {
        githubApiRateLimited = true;
        return null;
      }

      throw error;
    }
  })();

  repoTreeCache.set(cacheKey, pending);

  try {
    return await pending;
  } catch (error) {
    repoTreeCache.delete(cacheKey);
    throw error;
  }
}

async function listCatalogFromTree(repo: string, specs: CatalogRepoSpec[], ref = DEFAULT_REF): Promise<CatalogSkillEntry[] | null> {
  const tree = await getRepoTree(repo, ref);
  if (!tree) {
    return null;
  }

  const entries: CatalogSkillEntry[] = [];

  for (const spec of specs) {
    const skillPaths = listSkillPathsFromTree(tree, spec);
    for (const skillPath of skillPaths) {
      entries.push({
        id: `${repo}:${skillPath}:${spec.source}`,
        name: skillPath.split('/').pop() ?? skillPath,
        repo,
        path: skillPath,
        ref,
        source: spec.source,
        target: spec.target,
        catalogLabel: spec.catalogLabel,
        description: await readDescription(repo, skillPath, ref)
      });
    }
  }

  return sortCatalogEntries(entries);
}

function resolveCheckoutPath(checkoutDir: string, repoPath: string): string {
  return path.join(checkoutDir, ...repoPath.split('/').filter(Boolean));
}

async function discoverSkillDirectories(rootDir: string, maxDepth: number, depth = 0, relativePath = ''): Promise<string[]> {
  if (!(await pathExists(rootDir))) {
    return [];
  }

  const entries = await readdir(rootDir, { withFileTypes: true });
  const skillFile = entries.find(entry => entry.isFile() && entry.name === 'SKILL.md');
  if (skillFile) {
    return [relativePath];
  }

  if (depth >= maxDepth) {
    return [];
  }

  const directories = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name));

  const discovered: string[] = [];
  for (const entry of directories) {
    const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    discovered.push(...(await discoverSkillDirectories(path.join(rootDir, entry.name), maxDepth, depth + 1, nextRelativePath)));
  }

  return discovered;
}

async function listLocalFiles(rootDir: string, relativePath = ''): Promise<string[]> {
  const entries = (await readdir(rootDir, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];

  for (const entry of entries) {
    const nextRelativePath = relativePath ? path.posix.join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listLocalFiles(path.join(rootDir, entry.name), nextRelativePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(nextRelativePath);
    }
  }

  return files;
}

async function listCatalogFromGit(repo: string, specs: CatalogRepoSpec[], ref = DEFAULT_REF): Promise<CatalogSkillEntry[]> {
  const repoPaths = Array.from(new Set(specs.map(spec => spec.rootPath)));

  return withGitHubSparseCheckout(repo, repoPaths, ref, async checkoutDir => {
    const entries: CatalogSkillEntry[] = [];

    for (const spec of specs) {
      const rootDir = resolveCheckoutPath(checkoutDir, spec.rootPath);
      const skillDirs = await discoverSkillDirectories(rootDir, spec.maxDepth);

      for (const relativeSkillPath of skillDirs) {
        const skillPath = relativeSkillPath ? path.posix.join(spec.rootPath, relativeSkillPath) : spec.rootPath;
        const skillFile = path.join(resolveCheckoutPath(checkoutDir, skillPath), 'SKILL.md');
        const content = await readFile(skillFile, 'utf8').catch(() => '');

        entries.push({
          id: `${repo}:${skillPath}:${spec.source}`,
          name: skillPath.split('/').pop() ?? skillPath,
          repo,
          path: skillPath,
          ref,
          source: spec.source,
          target: spec.target,
          catalogLabel: spec.catalogLabel,
          description: readFrontmatterField(content, 'description') || 'No description available.'
        });
      }
    }

    return sortCatalogEntries(entries);
  });
}

async function buildCatalogPreviewFromTree(entry: CatalogSkillEntry, tree: GitHubTreeEntry[]): Promise<CatalogSkillPreview> {
  const skillFilePath = path.posix.join(entry.path, 'SKILL.md');
  const skillFileExists = tree.some(item => item.type === 'blob' && item.path === skillFilePath);
  if (!skillFileExists) {
    throw new Error(`The selected skill at ${entry.repo}:${entry.path} does not contain a SKILL.md file.`);
  }

  const [content, files] = await Promise.all([
    readRepoText(entry.repo, skillFilePath, entry.ref),
    Promise.resolve(listFolderFilesFromTree(tree, entry.path))
  ]);

  return {
    entry,
    content,
    files,
    requirements: inferRequirements(content, files)
  };
}

async function buildCatalogPreviewFromGit(entry: CatalogSkillEntry): Promise<CatalogSkillPreview> {
  return withGitHubSparseCheckout(entry.repo, [entry.path], entry.ref, async checkoutDir => {
    const skillDir = resolveCheckoutPath(checkoutDir, entry.path);
    const skillFile = path.join(skillDir, 'SKILL.md');

    if (!(await pathExists(skillFile))) {
      throw new Error(`The selected skill at ${entry.repo}:${entry.path} does not contain a SKILL.md file.`);
    }

    const [content, files] = await Promise.all([
      readFile(skillFile, 'utf8'),
      listLocalFiles(skillDir)
    ]);

    return {
      entry,
      content,
      files,
      requirements: inferRequirements(content, files)
    };
  });
}

async function listCatalogFromRepo(repo: string, specs: CatalogRepoSpec[], ref = DEFAULT_REF): Promise<CatalogSkillEntry[]> {
  const treeEntries = await listCatalogFromTree(repo, specs, ref);
  if (treeEntries) {
    return treeEntries;
  }

  return listCatalogFromGit(repo, specs, ref);
}

export async function listOpenAiCatalog(): Promise<CatalogSkillEntry[]> {
  return listCatalogFromRepo('openai/skills', [
    {
      rootPath: 'skills/.system',
      source: 'codex-system',
      target: 'codex',
      catalogLabel: 'OpenAI system',
      maxDepth: 1
    },
    {
      rootPath: 'skills/.curated',
      source: 'codex-curated',
      target: 'codex',
      catalogLabel: 'OpenAI curated',
      maxDepth: 1
    }
  ]);
}

export async function listCodexCatalog(): Promise<CatalogSkillEntry[]> {
  return listOpenAiCatalog();
}

export async function listClaudeCatalog(): Promise<CatalogSkillEntry[]> {
  return listCatalogFromRepo('anthropics/skills', [
    {
      rootPath: 'skills',
      source: 'claude-catalog',
      target: 'claude',
      catalogLabel: 'Claude official',
      maxDepth: 2
    }
  ]);
}

export async function previewCatalogSkill(entry: CatalogSkillEntry): Promise<CatalogSkillPreview> {
  const tree = await getRepoTree(entry.repo, entry.ref);
  if (tree) {
    return buildCatalogPreviewFromTree(entry, tree);
  }

  return buildCatalogPreviewFromGit(entry);
}

export async function previewGitHubSkill(spec: Pick<SkillInstallSpec, 'name' | 'repo' | 'path' | 'ref' | 'description'>): Promise<CatalogSkillPreview> {
  if (!spec.repo || !spec.path) {
    throw new Error('A GitHub skill preview needs both repository and path.');
  }

  const entry: CatalogSkillEntry = {
    id: `${spec.repo}:${spec.path}:github`,
    name: spec.name,
    repo: spec.repo,
    path: spec.path,
    ref: spec.ref || DEFAULT_REF,
    source: 'github',
    target: 'codex',
    catalogLabel: 'GitHub preview',
    description: spec.description ?? 'Custom GitHub skill.'
  };

  const tree = await getRepoTree(entry.repo, entry.ref);
  if (tree) {
    return buildCatalogPreviewFromTree(entry, tree);
  }

  return buildCatalogPreviewFromGit(entry);
}
