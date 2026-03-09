import os from 'node:os';
import path from 'node:path';
import { cp, readdir, rename, rm, stat } from 'node:fs/promises';

import type {
  ProviderName,
  RalphExecutionSkill,
  RalphiGlobalRegistry,
  RalphiProjectConfig,
  SkillInstallSpec,
  SkillInstallTarget,
  SkillScope
} from './types.js';
import { createSkillFromGitHub, readSkillFrontmatter } from './git.js';
import { defaultNotificationSettings, normalizeNotificationSettings } from './notifications.js';
import { localRalphiSkillDir } from './skills.js';
import { ensureDir, parseJsonFile, pathExists, summarizeSkillSource, writeJsonFile } from './utils.js';

const PROJECT_CONFIG_VERSION = 1;
const GLOBAL_REGISTRY_VERSION = 1;
const LEGACY_PROJECT_RUNTIME_ENTRIES = ['state', 'archive', '.tmp', 'prd.json'] as const;

export function ralphiHomeDir(): string {
  return path.join(os.homedir(), '.ralphi');
}

export function globalSkillDir(): string {
  return path.join(ralphiHomeDir(), 'skills');
}

export function globalProviderSkillDir(target: SkillInstallTarget): string {
  switch (target) {
    case 'amp':
      return path.join(os.homedir(), '.config', 'agents', 'skills');
    case 'codex':
      return path.join(os.homedir(), '.codex', 'skills', 'public');
    case 'claude':
      return path.join(os.homedir(), '.claude', 'skills');
    case 'copilot':
      return path.join(os.homedir(), '.copilot', 'skills');
    case 'opencode':
      return path.join(os.homedir(), '.config', 'opencode', 'skills');
    case 'qwen':
      return path.join(os.homedir(), '.qwen', 'skills');
    default:
      return globalSkillDir();
  }
}

export function globalRegistryPath(): string {
  return path.join(ralphiHomeDir(), 'registry.json');
}

export function projectRalphiDir(rootDir: string): string {
  return path.join(rootDir, '.ralphi');
}

export function projectConfigPath(rootDir: string): string {
  return path.join(rootDir, '.ralphi.json');
}

export function projectSkillDir(rootDir: string): string {
  return path.join(rootDir, '.ralph', 'skills');
}

export function projectProviderSkillDir(rootDir: string, target: SkillInstallTarget): string {
  switch (target) {
    case 'amp':
      return path.join(rootDir, '.agents', 'skills');
    case 'codex':
      return path.join(rootDir, '.codex', 'skills', 'public');
    case 'claude':
      return path.join(rootDir, '.claude', 'skills');
    case 'copilot':
      return path.join(rootDir, '.github', 'skills');
    case 'opencode':
      return path.join(rootDir, '.opencode', 'skills');
    case 'qwen':
      return path.join(rootDir, '.qwen', 'skills');
    default:
      return projectSkillDir(rootDir);
  }
}

function migrateLegacyCodexLocalSkillSpec(spec: SkillInstallSpec): SkillInstallSpec {
  if (spec.target !== 'codex' || spec.source !== 'local' || !spec.path) {
    return spec;
  }

  const normalizedPath = spec.path.split('\\').join('/');
  const legacyPrefix = '.codex/skills/';

  if (
    !normalizedPath.startsWith(legacyPrefix) ||
    normalizedPath.startsWith('.codex/skills/public/') ||
    normalizedPath.startsWith('.codex/skills/.')
  ) {
    return spec;
  }

  return {
    ...spec,
    path: `.codex/skills/public/${normalizedPath.slice(legacyPrefix.length)}`
  };
}

function defaultProjectConfig(): RalphiProjectConfig {
  return {
    version: PROJECT_CONFIG_VERSION,
    defaults: {
      tool: 'amp',
      schedule: 'round-robin',
      verbose: false,
      workspaceStrategy: 'worktree',
      iterations: 10,
      environment: 'local'
    },
    notifications: defaultNotificationSettings(),
    skills: []
  };
}

export function providerSkillTarget(provider: ProviderName): SkillInstallTarget | null {
  switch (provider) {
    case 'amp':
      return 'amp';
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'copilot':
      return 'copilot';
    case 'cursor':
    case 'gemini':
      return null;
    case 'opencode':
      return 'opencode';
    case 'qwen':
      return 'qwen';
  }
}

export function providerExecutableName(provider: ProviderName): string {
  switch (provider) {
    case 'cursor':
      return 'cursor-agent';
    default:
      return provider;
  }
}

function defaultGlobalRegistry(): RalphiGlobalRegistry {
  return {
    version: GLOBAL_REGISTRY_VERSION,
    skills: []
  };
}

function legacyProjectRuntimeDir(rootDir: string): string {
  return path.join(rootDir, 'ralph');
}

async function moveLegacyRuntimeEntry(sourcePath: string, targetPath: string): Promise<boolean> {
  if (!(await pathExists(sourcePath)) || (await pathExists(targetPath))) {
    return false;
  }

  await ensureDir(path.dirname(targetPath));

  try {
    await rename(sourcePath, targetPath);
    return true;
  } catch {
    const sourceStats = await stat(sourcePath).catch(() => null);
    if (!sourceStats) {
      return false;
    }

    if (sourceStats.isDirectory()) {
      await cp(sourcePath, targetPath, { recursive: true });
      await rm(sourcePath, { recursive: true, force: true });
      return true;
    }

    await cp(sourcePath, targetPath);
    await rm(sourcePath, { force: true });
    return true;
  }
}

export async function migrateLegacyProjectRuntime(rootDir: string): Promise<void> {
  const legacyDir = legacyProjectRuntimeDir(rootDir);
  if (!(await pathExists(legacyDir))) {
    return;
  }

  let movedAny = false;
  const nextDir = projectRalphiDir(rootDir);

  for (const entry of LEGACY_PROJECT_RUNTIME_ENTRIES) {
    const moved = await moveLegacyRuntimeEntry(path.join(legacyDir, entry), path.join(nextDir, entry));
    movedAny ||= moved;
  }

  if (!movedAny) {
    return;
  }

  const remainingEntries = await readdir(legacyDir).catch(() => null);
  if (remainingEntries && remainingEntries.length === 0) {
    await rm(legacyDir, { recursive: true, force: true });
  }
}

export async function ensureRalphiHome(): Promise<void> {
  await Promise.all([
    ensureDir(ralphiHomeDir()),
    ensureDir(globalSkillDir()),
    ensureDir(globalProviderSkillDir('amp')),
    ensureDir(globalProviderSkillDir('codex')),
    ensureDir(globalProviderSkillDir('claude')),
    ensureDir(globalProviderSkillDir('copilot')),
    ensureDir(globalProviderSkillDir('opencode')),
    ensureDir(globalProviderSkillDir('qwen'))
  ]);
}

export async function loadProjectConfig(rootDir: string): Promise<{
  config: RalphiProjectConfig;
  created: boolean;
  detected: boolean;
  configPath: string;
}> {
  const configPath = projectConfigPath(rootDir);
  const detected = await pathExists(configPath);
  const parsed = await parseJsonFile<RalphiProjectConfig>(configPath);

  if (parsed?.version === PROJECT_CONFIG_VERSION) {
    const defaults = defaultProjectConfig();
    const migratedSkills = (parsed.skills ?? []).map(migrateLegacyCodexLocalSkillSpec);
    const config = {
      ...defaults,
      ...parsed,
      defaults: {
        ...defaults.defaults,
        ...parsed.defaults
      },
      notifications: normalizeNotificationSettings(parsed.notifications),
      skills: migratedSkills
    };

    if (JSON.stringify(parsed) !== JSON.stringify(config)) {
      await writeJsonFile(configPath, config);
    }

    return {
      config,
      created: false,
      detected,
      configPath
    };
  }

  const config = defaultProjectConfig();
  await writeJsonFile(configPath, config);

  return {
    config,
    created: true,
    detected,
    configPath
  };
}

export async function saveProjectConfig(rootDir: string, config: RalphiProjectConfig): Promise<void> {
  await writeJsonFile(projectConfigPath(rootDir), {
    ...config,
    notifications: normalizeNotificationSettings(config.notifications)
  });
}

export async function loadGlobalRegistry(): Promise<RalphiGlobalRegistry> {
  await ensureRalphiHome();
  const parsed = await parseJsonFile<RalphiGlobalRegistry>(globalRegistryPath());
  if (parsed?.version === GLOBAL_REGISTRY_VERSION) {
    const skills = (parsed.skills ?? []).map(migrateLegacyCodexLocalSkillSpec);
    if (JSON.stringify(parsed.skills ?? []) !== JSON.stringify(skills)) {
      await writeJsonFile(globalRegistryPath(), {
        version: GLOBAL_REGISTRY_VERSION,
        skills
      });
    }

    return {
      version: GLOBAL_REGISTRY_VERSION,
      skills
    };
  }

  const registry = defaultGlobalRegistry();
  await writeJsonFile(globalRegistryPath(), registry);
  return registry;
}

export async function saveGlobalRegistry(registry: RalphiGlobalRegistry): Promise<void> {
  await ensureRalphiHome();
  await writeJsonFile(globalRegistryPath(), registry);
}

export function resolveSkillTargetDir(rootDir: string, scope: SkillScope, target: SkillInstallTarget, skillName: string): string {
  const parentDir = scope === 'global' ? globalProviderSkillDir(target) : projectProviderSkillDir(rootDir, target);
  return path.join(parentDir, skillName);
}

async function copyLocalSkillDirectory(sourceDir: string, targetDir: string): Promise<void> {
  const normalizedSource = path.resolve(sourceDir);
  const normalizedTarget = path.resolve(targetDir);

  if (!(await pathExists(sourceDir))) {
    throw new Error(`Local skill source not found: ${sourceDir}`);
  }

  if (!(await pathExists(path.join(sourceDir, 'SKILL.md')))) {
    throw new Error(`Local skill source is missing SKILL.md: ${sourceDir}`);
  }

  if (normalizedSource === normalizedTarget || (await pathExists(targetDir))) {
    return;
  }

  await ensureDir(path.dirname(targetDir));
  await cp(sourceDir, targetDir, { recursive: true, force: true });
}

export async function installLocalSkill(options: {
  rootDir: string;
  name: string;
  sourceDir: string;
  scope: SkillScope;
  target: SkillInstallTarget;
}): Promise<{ targetDir: string }> {
  const targetDir = resolveSkillTargetDir(options.rootDir, options.scope, options.target, options.name);
  await copyLocalSkillDirectory(options.sourceDir, targetDir);
  return { targetDir };
}

function normalizeSpec(spec: SkillInstallSpec): SkillInstallSpec {
  return migrateLegacyCodexLocalSkillSpec({
    ...spec,
    ref: spec.ref || 'main',
    target:
      spec.target ||
      (spec.source === 'claude-catalog'
        ? 'claude'
        : spec.source === 'codex-curated' || spec.source === 'codex-system'
          ? 'codex'
          : 'ralphi')
  });
}

export async function installSkill(rootDir: string, spec: SkillInstallSpec): Promise<{ spec: SkillInstallSpec; targetDir: string }> {
  await ensureRalphiHome();

  const normalized = normalizeSpec(spec);
  const targetDir = resolveSkillTargetDir(rootDir, normalized.scope, normalized.target, normalized.name);
  await ensureDir(path.dirname(targetDir));

  if (normalized.source === 'local') {
    const localPath = String(normalized.path ?? '').trim();
    if (!localPath) {
      throw new Error(`Skill ${normalized.name} is missing its local source path.`);
    }

    const sourceDir = path.isAbsolute(localPath) ? localPath : path.resolve(rootDir, localPath);
    await installLocalSkill({
      rootDir,
      name: normalized.name,
      sourceDir,
      scope: normalized.scope,
      target: normalized.target
    });

    return {
      spec: normalized,
      targetDir
    };
  }

  let repo = normalized.repo;
  let repoPath = normalized.path;

  if (normalized.source === 'codex-curated') {
    repo = repo || 'openai/skills';
    repoPath = repoPath || `skills/.curated/${normalized.name}`;
  } else if (normalized.source === 'codex-system') {
    repo = repo || 'openai/skills';
    repoPath = repoPath || `skills/.system/${normalized.name}`;
  } else if (normalized.source === 'claude-catalog') {
    repo = repo || 'anthropics/skills';
    repoPath = repoPath || `skills/${normalized.name}`;
  }

  if (!repo || !repoPath) {
    throw new Error(`Skill ${normalized.name} is missing repository metadata.`);
  }

  await createSkillFromGitHub(targetDir, repo, repoPath, normalized.ref);

  if (normalized.scope === 'global') {
    const registry = await loadGlobalRegistry();
    const deduped = registry.skills.filter(
      entry => !(entry.scope === 'global' && entry.target === normalized.target && entry.name === normalized.name)
    );
    deduped.push(normalized);
    await saveGlobalRegistry({
      version: GLOBAL_REGISTRY_VERSION,
      skills: deduped
    });
  }

  return {
    spec: normalized,
    targetDir
  };
}

export function buildExecutionSkills(
  rootDir: string,
  provider: ProviderName,
  config: RalphiProjectConfig,
  sessionSkills: RalphExecutionSkill[] = []
): RalphExecutionSkill[] {
  const target = providerSkillTarget(provider);
  const selected = new Map<string, RalphExecutionSkill>();

  if (target) {
    for (const entry of config.skills ?? []) {
      const spec = normalizeSpec(entry);

      if (spec.target !== target) {
        continue;
      }

      selected.set(`${provider}:${spec.name}`, {
        id: spec.id,
        name: spec.name,
        provider,
        sourcePath: resolveSkillTargetDir(rootDir, spec.scope, spec.target, spec.name),
        description: spec.description,
        persisted: true
      });
    }
  }

  for (const skill of sessionSkills) {
    if (skill.provider !== provider) {
      continue;
    }

    const key = `${provider}:${skill.name}`;
    if (selected.has(key)) {
      continue;
    }

    selected.set(key, skill);
  }

  return Array.from(selected.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export async function syncProjectSkills(
  rootDir: string,
  config: RalphiProjectConfig,
  reporter?: (progress: { current: number; total: number; spec: SkillInstallSpec; targetDir: string }) => Promise<void> | void
): Promise<number> {
  const skills = config.skills ?? [];
  let installed = 0;

  for (let index = 0; index < skills.length; index += 1) {
    const spec = normalizeSpec(skills[index]);
    const targetDir = resolveSkillTargetDir(rootDir, spec.scope, spec.target, spec.name);
    if (await pathExists(targetDir)) {
      continue;
    }

    await installSkill(rootDir, spec);
    installed += 1;
    await reporter?.({
      current: index + 1,
      total: skills.length,
      spec,
      targetDir
    });
  }

  return installed;
}

export async function listInstalledSkills(rootDir: string): Promise<{
  project: Array<SkillInstallSpec & { targetDir: string; description: string }>;
  global: Array<SkillInstallSpec & { targetDir: string; description: string }>;
}> {
  await ensureRalphiHome();
  const registry = await loadGlobalRegistry();
  const config = await loadProjectConfig(rootDir);

  const enrich = async (entry: SkillInstallSpec): Promise<SkillInstallSpec & { targetDir: string; description: string }> => {
    const normalized = normalizeSpec(entry);
    const targetDir = resolveSkillTargetDir(rootDir, normalized.scope, normalized.target, normalized.name);
    if (await pathExists(targetDir)) {
      const frontmatter = await readSkillFrontmatter(targetDir).catch(() => ({
        name: normalized.name,
        description: summarizeSkillSource(normalized)
      }));
      return {
        ...normalized,
        targetDir,
        description: frontmatter.description
      };
    }

    return {
      ...normalized,
      targetDir,
      description: summarizeSkillSource(normalized)
    };
  };

  return {
    project: await Promise.all(config.config.skills.filter(entry => entry.scope === 'project').map(enrich)),
    global: await Promise.all(registry.skills.filter(entry => entry.scope === 'global').map(enrich))
  };
}

export async function listBuiltinSkills(): Promise<Array<{ name: string; targetDir: string; description: string }>> {
  const skillDir = localRalphiSkillDir();
  const entries = await readdir(skillDir, { withFileTypes: true }).catch(() => []);
  const skills = await Promise.all(
    entries
      .filter(entry => entry.isDirectory() && entry.name !== '_internal')
      .map(async entry => {
        const targetDir = path.join(skillDir, entry.name);
        const frontmatter = await readSkillFrontmatter(targetDir).catch(() => ({
          name: entry.name,
          description: 'No description provided.'
        }));
        return {
          name: frontmatter.name || entry.name,
          targetDir,
          description: frontmatter.description
        };
      })
  );

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function addProjectSkill(rootDir: string, spec: SkillInstallSpec): Promise<RalphiProjectConfig> {
  const { config } = await loadProjectConfig(rootDir);
  const normalized = normalizeSpec(spec);
  const nextSkills = config.skills.filter(
    entry => !(entry.scope === normalized.scope && entry.target === normalized.target && entry.name === normalized.name)
  );
  nextSkills.push(normalized);
  const nextConfig = {
    ...config,
    skills: nextSkills
  };
  await saveProjectConfig(rootDir, nextConfig);
  return nextConfig;
}
