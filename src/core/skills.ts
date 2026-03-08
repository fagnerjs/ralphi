import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type SkillProvider = 'ralphi' | 'codex' | 'claude' | 'amp' | 'copilot' | 'opencode' | 'qwen';
export type SkillOrigin = 'builtin' | 'project' | 'global';

export interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  filePath: string;
  rootDir: string;
  provider: SkillProvider;
  origin: SkillOrigin;
  label: string;
  external: boolean;
}

export interface SkillRegistrySnapshot {
  content: string;
  skills: DiscoveredSkill[];
}

interface SkillSearchRoot {
  dir: string;
  provider: SkillProvider;
  origin: SkillOrigin;
  label: string;
  external: boolean;
}

export function localRalphiSkillDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
}

export function builtinSkillFile(skillName: string): string {
  return path.join(localRalphiSkillDir(), skillName, 'SKILL.md');
}

async function collectSkillFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectSkillFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name === 'SKILL.md') {
      files.push(fullPath);
    }
  }

  return files;
}

function readFrontmatterField(content: string, field: 'name' | 'description'): string {
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

function skillRoots(rootDir: string, options?: {
  includeBuiltinRalphi?: boolean;
  includeRalphiManaged?: boolean;
  includeProviderDirs?: boolean;
}): SkillSearchRoot[] {
  const includeBuiltinRalphi = options?.includeBuiltinRalphi ?? true;
  const includeRalphiManaged = options?.includeRalphiManaged ?? true;
  const includeProviderDirs = options?.includeProviderDirs ?? true;
  const roots: SkillSearchRoot[] = [];

  if (includeBuiltinRalphi) {
    roots.push({
      dir: localRalphiSkillDir(),
      provider: 'ralphi',
      origin: 'builtin',
      label: 'Ralphi built-in',
      external: false
    });
  }

  if (includeRalphiManaged) {
    roots.push(
      {
        dir: path.join(rootDir, '.ralph', 'skills'),
        provider: 'ralphi',
        origin: 'project',
        label: 'Ralphi project',
        external: false
      },
      {
        dir: path.join(os.homedir(), '.ralphi', 'skills'),
        provider: 'ralphi',
        origin: 'global',
        label: 'Ralphi global',
        external: false
      }
    );
  }

  if (includeProviderDirs) {
    roots.push(
      {
        dir: path.join(rootDir, '.codex', 'skills', 'public'),
        provider: 'codex',
        origin: 'project',
        label: 'Codex project',
        external: true
      },
      {
        dir: path.join(os.homedir(), '.codex', 'skills', 'public'),
        provider: 'codex',
        origin: 'global',
        label: 'Codex global',
        external: true
      },
      {
        dir: path.join(rootDir, '.claude', 'skills'),
        provider: 'claude',
        origin: 'project',
        label: 'Claude project',
        external: true
      },
      {
        dir: path.join(os.homedir(), '.claude', 'skills'),
        provider: 'claude',
        origin: 'global',
        label: 'Claude global',
        external: true
      },
      {
        dir: path.join(rootDir, '.agents', 'skills'),
        provider: 'amp',
        origin: 'project',
        label: 'Agents project',
        external: true
      },
      {
        dir: path.join(os.homedir(), '.config', 'agents', 'skills'),
        provider: 'amp',
        origin: 'global',
        label: 'Agents global',
        external: true
      },
      {
        dir: path.join(rootDir, '.github', 'skills'),
        provider: 'copilot',
        origin: 'project',
        label: 'Copilot project',
        external: true
      },
      {
        dir: path.join(os.homedir(), '.copilot', 'skills'),
        provider: 'copilot',
        origin: 'global',
        label: 'Copilot global',
        external: true
      },
      {
        dir: path.join(rootDir, '.opencode', 'skills'),
        provider: 'opencode',
        origin: 'project',
        label: 'OpenCode project',
        external: true
      },
      {
        dir: path.join(os.homedir(), '.config', 'opencode', 'skills'),
        provider: 'opencode',
        origin: 'global',
        label: 'OpenCode global',
        external: true
      },
      {
        dir: path.join(rootDir, '.qwen', 'skills'),
        provider: 'qwen',
        origin: 'project',
        label: 'Qwen project',
        external: true
      },
      {
        dir: path.join(os.homedir(), '.qwen', 'skills'),
        provider: 'qwen',
        origin: 'global',
        label: 'Qwen global',
        external: true
      }
    );
  }

  return roots;
}

async function readSkillEntry(skillFile: string, root: SkillSearchRoot): Promise<DiscoveredSkill> {
  const content = await readFile(skillFile, 'utf8');
  const name = readFrontmatterField(content, 'name') || path.basename(path.dirname(skillFile));
  const description = readFrontmatterField(content, 'description') || 'No description provided.';

  return {
    id: `${root.provider}:${root.origin}:${skillFile}`,
    name,
    description,
    filePath: skillFile,
    rootDir: root.dir,
    provider: root.provider,
    origin: root.origin,
    label: root.label,
    external: root.external
  };
}

export async function discoverSkills(
  rootDir: string,
  options?: {
    includeBuiltinRalphi?: boolean;
    includeRalphiManaged?: boolean;
    includeProviderDirs?: boolean;
    externalOnly?: boolean;
  }
): Promise<DiscoveredSkill[]> {
  const roots = skillRoots(rootDir, {
    includeBuiltinRalphi: options?.externalOnly ? false : options?.includeBuiltinRalphi,
    includeRalphiManaged: options?.externalOnly ? false : options?.includeRalphiManaged,
    includeProviderDirs: options?.includeProviderDirs
  }).filter(root => (options?.externalOnly ? root.external : true));

  const entries: DiscoveredSkill[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    try {
      const files = (await collectSkillFiles(root.dir)).sort((left, right) => left.localeCompare(right));

      for (const skillFile of files) {
        if (seen.has(skillFile)) {
          continue;
        }

        seen.add(skillFile);
        entries.push(await readSkillEntry(skillFile, root));
      }
    } catch {
      continue;
    }
  }

  return entries.sort((left, right) =>
    left.label === right.label ? left.name.localeCompare(right.name) : left.label.localeCompare(right.label)
  );
}

export async function loadSkillFile(skillFilePath: string): Promise<string> {
  return readFile(skillFilePath, 'utf8');
}

export async function buildSkillRegistrySnapshot(rootDir: string): Promise<SkillRegistrySnapshot> {
  const skills = await discoverSkills(rootDir, {
    includeBuiltinRalphi: true,
    includeRalphiManaged: true,
    includeProviderDirs: true
  });
  const skillEntries: string[] = [];

  for (const skill of skills) {
    skillEntries.push(`- ${skill.name}: ${skill.description} [${skill.label}] (file: ${skill.filePath})`);
  }

  if (skillEntries.length === 0) {
    skillEntries.push('- No local skills were found.');
  }

  return {
    content: [
      '## Skills',
      'A skill is a set of local instructions stored in a `SKILL.md` file.',
      '### Available skills',
      ...skillEntries,
      '### How to use skills',
      '- Discovery: The list above is the skills available in this run. Skill bodies live on disk at the listed paths.',
      '- Trigger rules: If a skill is named explicitly or the task clearly matches its description, use that skill for this run.',
      '- How to use a skill:',
      '  1. Open its `SKILL.md`.',
      '  2. Read only enough to follow the workflow.',
      '  3. Load only the referenced files you actually need.',
      '  4. Reuse referenced scripts, assets, or templates instead of rewriting them.',
      '- Context hygiene:',
      '  - Keep context small.',
      '  - Prefer the directly linked files over broad repository searches.',
      '- Safety and fallback: If a skill cannot be applied cleanly, state the issue briefly and continue with the best fallback.',
      ''
    ].join('\n'),
    skills
  };
}

export async function buildSkillRegistry(rootDir: string): Promise<string> {
  return (await buildSkillRegistrySnapshot(rootDir)).content;
}
