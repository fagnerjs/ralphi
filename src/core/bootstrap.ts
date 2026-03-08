import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { findDevcontainerConfig } from './devcontainer.js';
import { projectProviderSkillDir } from './project.js';
import { ensureDir, pathExists } from './utils.js';

export type ProjectBootstrapKind =
  | 'agents-md'
  | 'claude-md'
  | 'copilot-instructions'
  | 'copilot-path-instructions'
  | 'cursor-rules'
  | 'codex-skill-dir'
  | 'claude-skill-dir'
  | 'ralphi-state-gitignore'
  | 'claude-local-gitignore'
  | 'devcontainer';

export interface ProjectBootstrapItem {
  id: ProjectBootstrapKind;
  label: string;
  description: string;
  targetPath: string;
  recommended: boolean;
  selected: boolean;
  previewTitle: string;
  previewLines: string[];
}

export interface ProjectBootstrapInspection {
  items: ProjectBootstrapItem[];
  devcontainerConfigPath: string | null;
}

interface PackageJsonShape {
  name?: string;
  scripts?: Record<string, string>;
  packageManager?: string;
}

type ProjectStack = 'node' | 'python' | 'go' | 'rust' | 'generic';

async function readPackageJson(rootDir: string): Promise<PackageJsonShape | null> {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!(await pathExists(packageJsonPath))) {
    return null;
  }

  try {
    return JSON.parse(await readFile(packageJsonPath, 'utf8')) as PackageJsonShape;
  } catch {
    return null;
  }
}

async function detectProjectStack(rootDir: string): Promise<ProjectStack> {
  if (await pathExists(path.join(rootDir, 'package.json'))) {
    return 'node';
  }
  if ((await pathExists(path.join(rootDir, 'pyproject.toml'))) || (await pathExists(path.join(rootDir, 'requirements.txt')))) {
    return 'python';
  }
  if (await pathExists(path.join(rootDir, 'go.mod'))) {
    return 'go';
  }
  if (await pathExists(path.join(rootDir, 'Cargo.toml'))) {
    return 'rust';
  }

  return 'generic';
}

async function detectPackageManager(rootDir: string, packageJson: PackageJsonShape | null): Promise<string> {
  if (packageJson?.packageManager) {
    return packageJson.packageManager.split('@')[0];
  }
  if (await pathExists(path.join(rootDir, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (await pathExists(path.join(rootDir, 'yarn.lock'))) {
    return 'yarn';
  }
  if (await pathExists(path.join(rootDir, 'bun.lockb'))) {
    return 'bun';
  }

  return 'npm';
}

function buildCommandHints(stack: ProjectStack, packageManager: string, packageJson: PackageJsonShape | null): string[] {
  if (stack !== 'node') {
    return [
      '- Install dependencies using the project-standard command before running checks.',
      '- Run the project test and lint commands before finishing a task.',
      '- Keep the instructions in this file aligned with the real project workflow.'
    ];
  }

  const installCommand =
    packageManager === 'pnpm'
      ? 'pnpm install'
      : packageManager === 'yarn'
        ? 'yarn install'
        : packageManager === 'bun'
          ? 'bun install'
          : 'npm install';

  const scripts = packageJson?.scripts ?? {};
  const checks = ['typecheck', 'lint', 'test', 'build']
    .filter(name => Boolean(scripts[name]))
    .map(name =>
      packageManager === 'pnpm'
        ? `pnpm run ${name}`
        : packageManager === 'yarn'
          ? `yarn ${name}`
          : packageManager === 'bun'
            ? `bun run ${name}`
            : `npm run ${name}`
    );

  return [
    `- Install dependencies with \`${installCommand}\` before coding.`,
    checks.length > 0
      ? `- Run the relevant verification commands before finishing: ${checks.join(', ')}.`
      : '- Add the main verification commands here once the project scripts are defined.',
    '- Keep changes scoped, and do not revert unrelated user work.'
  ];
}

async function buildAgentsTemplate(rootDir: string): Promise<string> {
  const packageJson = await readPackageJson(rootDir);
  const stack = await detectProjectStack(rootDir);
  const packageManager = await detectPackageManager(rootDir, packageJson);
  const projectName = packageJson?.name || path.basename(rootDir);

  return [
    '# AGENTS.md',
    '',
    '## Project',
    `- Name: ${projectName}`,
    `- Root: ${path.basename(rootDir)}`,
    `- Primary stack: ${stack}`,
    '',
    '## Working agreement',
    ...buildCommandHints(stack, packageManager, packageJson),
    '- Prefer the existing project conventions over introducing new abstractions.',
    '- Update this file when the workflow changes.',
    ''
  ].join('\n');
}

async function buildClaudeTemplate(rootDir: string): Promise<string> {
  const packageJson = await readPackageJson(rootDir);
  const stack = await detectProjectStack(rootDir);
  const packageManager = await detectPackageManager(rootDir, packageJson);
  const projectName = packageJson?.name || path.basename(rootDir);

  return [
    '# CLAUDE.md',
    '',
    '## Project memory',
    `- Name: ${projectName}`,
    `- Primary stack: ${stack}`,
    `- Root folder: ${path.basename(rootDir)}`,
    '',
    '## Workflow',
    ...buildCommandHints(stack, packageManager, packageJson),
    '- Read AGENTS.md and this file before making large changes.',
    '- Keep implementation notes concise and update the project memory when the workflow shifts.',
    ''
  ].join('\n');
}

async function buildCopilotInstructionsTemplate(rootDir: string): Promise<string> {
  const packageJson = await readPackageJson(rootDir);
  const stack = await detectProjectStack(rootDir);
  const packageManager = await detectPackageManager(rootDir, packageJson);
  const projectName = packageJson?.name || path.basename(rootDir);

  return [
    '# Copilot Instructions',
    '',
    '## Project',
    `- Name: ${projectName}`,
    `- Primary stack: ${stack}`,
    `- Root folder: ${path.basename(rootDir)}`,
    '',
    '## Workflow',
    ...buildCommandHints(stack, packageManager, packageJson),
    '- Prefer the existing project conventions over introducing new abstractions.',
    '- Read AGENTS.md before large changes when it exists.',
    ''
  ].join('\n');
}

function copilotPathInstructionApplyTo(stack: ProjectStack): string {
  switch (stack) {
    case 'node':
      return '**/*.{ts,tsx,js,jsx,mjs,cjs}';
    case 'python':
      return '**/*.{py,pyi}';
    case 'go':
      return '**/*.go';
    case 'rust':
      return '**/*.rs';
    default:
      return '**/*';
  }
}

async function buildCopilotPathInstructionsTemplate(rootDir: string): Promise<string> {
  const packageJson = await readPackageJson(rootDir);
  const stack = await detectProjectStack(rootDir);
  const packageManager = await detectPackageManager(rootDir, packageJson);
  const projectName = packageJson?.name || path.basename(rootDir);
  const applyTo = copilotPathInstructionApplyTo(stack);

  return [
    '---',
    `applyTo: "${applyTo}"`,
    '---',
    '',
    '# Path-specific Copilot instructions',
    '',
    '## Scope',
    `- Applies to files matching \`${applyTo}\` in \`${projectName}\`.`,
    '',
    '## Expectations',
    ...buildCommandHints(stack, packageManager, packageJson),
    '- Keep edits focused on the matching code paths and avoid unrelated refactors.',
    '- Follow AGENTS.md and repository-wide Copilot instructions when they exist.',
    ''
  ].join('\n');
}

async function buildCursorRuleTemplate(rootDir: string): Promise<string> {
  const packageJson = await readPackageJson(rootDir);
  const stack = await detectProjectStack(rootDir);
  const packageManager = await detectPackageManager(rootDir, packageJson);
  const projectName = packageJson?.name || path.basename(rootDir);

  return [
    '---',
    'description: Project-wide guidance for coding agents working in this repository',
    'alwaysApply: true',
    '---',
    '',
    '# Project context',
    `- Name: ${projectName}`,
    `- Primary stack: ${stack}`,
    `- Root folder: ${path.basename(rootDir)}`,
    '',
    '# Workflow',
    ...buildCommandHints(stack, packageManager, packageJson),
    '- Prefer the existing project conventions over introducing new abstractions.',
    '- Read AGENTS.md before large changes when it exists.',
    ''
  ].join('\n');
}

async function buildDevcontainerTemplate(rootDir: string): Promise<string> {
  const stack = await detectProjectStack(rootDir);
  const packageJson = await readPackageJson(rootDir);
  const packageManager = await detectPackageManager(rootDir, packageJson);

  if (stack === 'node') {
    const postCreateCommand =
      packageManager === 'pnpm'
        ? 'pnpm install'
        : packageManager === 'yarn'
          ? 'yarn install'
          : packageManager === 'bun'
            ? 'bun install'
            : 'npm install';

    return [
      '{',
      '  "name": "Ralphi workspace",',
      '  "image": "mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm",',
      `  "postCreateCommand": "${postCreateCommand}"`,
      '}',
      ''
    ].join('\n');
  }

  if (stack === 'python') {
    return [
      '{',
      '  "name": "Ralphi workspace",',
      '  "image": "mcr.microsoft.com/devcontainers/python:1-3.12-bookworm"',
      '}',
      ''
    ].join('\n');
  }

  return [
    '{',
    '  "name": "Ralphi workspace",',
    '  "image": "mcr.microsoft.com/devcontainers/base:ubuntu"',
    '}',
    ''
  ].join('\n');
}

async function ensureGitignoreEntries(rootDir: string, entries: string[]): Promise<void> {
  const gitignorePath = path.join(rootDir, '.gitignore');
  const current = (await pathExists(gitignorePath)) ? await readFile(gitignorePath, 'utf8') : '';
  const lines = current.split('\n');
  const missing = entries.filter(entry => !lines.some(line => line.trim() === entry));

  if (missing.length === 0) {
    return;
  }

  const next = current.replace(/\s+$/, '');
  const content = [next, next ? '' : null, ...missing, ''].filter((value): value is string => value !== null).join('\n');
  await writeFile(gitignorePath, content, 'utf8');
}

function renderPreview(title: string, targetPath: string, content: string): string[] {
  return [`# ${title}`, '', `Target: ${targetPath}`, '', ...content.split('\n')];
}

export async function inspectProjectBootstrap(rootDir: string): Promise<ProjectBootstrapInspection> {
  const devcontainerConfigPath = await findDevcontainerConfig(rootDir);
  const items: ProjectBootstrapItem[] = [];

  const agentsPath = path.join(rootDir, 'AGENTS.md');
  if (!(await pathExists(agentsPath))) {
    const content = await buildAgentsTemplate(rootDir);
    items.push({
      id: 'agents-md',
      label: 'Create AGENTS.md',
      description: 'Add repository instructions for Codex and other coding agents.',
      targetPath: agentsPath,
      recommended: true,
      selected: true,
      previewTitle: 'AGENTS.md',
      previewLines: renderPreview('AGENTS.md', agentsPath, content)
    });
  }

  const claudePath = path.join(rootDir, 'CLAUDE.md');
  if (!(await pathExists(claudePath))) {
    const content = await buildClaudeTemplate(rootDir);
    items.push({
      id: 'claude-md',
      label: 'Create CLAUDE.md',
      description: 'Add project memory for Claude Code.',
      targetPath: claudePath,
      recommended: true,
      selected: true,
      previewTitle: 'CLAUDE.md',
      previewLines: renderPreview('CLAUDE.md', claudePath, content)
    });
  }

  const copilotInstructionsPath = path.join(rootDir, '.github', 'copilot-instructions.md');
  if (!(await pathExists(copilotInstructionsPath))) {
    const content = await buildCopilotInstructionsTemplate(rootDir);
    items.push({
      id: 'copilot-instructions',
      label: 'Create .github/copilot-instructions.md',
      description: 'Scaffold the repository-wide GitHub Copilot instructions file.',
      targetPath: copilotInstructionsPath,
      recommended: false,
      selected: false,
      previewTitle: '.github/copilot-instructions.md',
      previewLines: renderPreview('.github/copilot-instructions.md', copilotInstructionsPath, content)
    });
  }

  const copilotPathInstructionsPath = path.join(rootDir, '.github', 'instructions', 'code.instructions.md');
  if (!(await pathExists(copilotPathInstructionsPath))) {
    const content = await buildCopilotPathInstructionsTemplate(rootDir);
    items.push({
      id: 'copilot-path-instructions',
      label: 'Create .github/instructions/code.instructions.md',
      description: 'Scaffold a path-specific GitHub Copilot instructions file with an applyTo glob.',
      targetPath: copilotPathInstructionsPath,
      recommended: false,
      selected: false,
      previewTitle: '.github/instructions/code.instructions.md',
      previewLines: renderPreview('.github/instructions/code.instructions.md', copilotPathInstructionsPath, content)
    });
  }

  const cursorRulePath = path.join(rootDir, '.cursor', 'rules', 'ralphi-project.mdc');
  if (!(await pathExists(cursorRulePath))) {
    const content = await buildCursorRuleTemplate(rootDir);
    items.push({
      id: 'cursor-rules',
      label: 'Create .cursor/rules starter',
      description: 'Scaffold a project-wide Cursor rule file under .cursor/rules/.',
      targetPath: cursorRulePath,
      recommended: false,
      selected: false,
      previewTitle: '.cursor/rules/ralphi-project.mdc',
      previewLines: renderPreview('.cursor/rules/ralphi-project.mdc', cursorRulePath, content)
    });
  }

  const codexSkillDir = projectProviderSkillDir(rootDir, 'codex');
  if (!(await pathExists(codexSkillDir))) {
    items.push({
      id: 'codex-skill-dir',
      label: 'Create .codex/skills/public',
      description: 'Scaffold the official project-local Codex public skills directory.',
      targetPath: codexSkillDir,
      recommended: false,
      selected: false,
      previewTitle: '.codex/skills/public',
      previewLines: [
        '# .codex/skills/public',
        '',
        `Target: ${codexSkillDir}`,
        '',
        'Ralphi will create the directory and add a .gitkeep placeholder.'
      ]
    });
  }

  const claudeSkillDir = projectProviderSkillDir(rootDir, 'claude');
  if (!(await pathExists(claudeSkillDir))) {
    items.push({
      id: 'claude-skill-dir',
      label: 'Create .claude/skills',
      description: 'Scaffold the official project-local Claude skills directory.',
      targetPath: claudeSkillDir,
      recommended: false,
      selected: false,
      previewTitle: '.claude/skills',
      previewLines: [
        '# .claude/skills',
        '',
        `Target: ${claudeSkillDir}`,
        '',
        'Ralphi will create the directory and add a .gitkeep placeholder.'
      ]
    });
  }

  const gitignorePath = path.join(rootDir, '.gitignore');
  const gitignoreContent = (await pathExists(gitignorePath)) ? await readFile(gitignorePath, 'utf8') : '';
  if (!gitignoreContent.split('\n').some(line => line.trim() === '.ralphi/')) {
    items.push({
      id: 'ralphi-state-gitignore',
      label: 'Update .gitignore for Ralphi state',
      description: 'Ignore .ralphi/ so local checkpoints, archives, and temporary runtime files stay untracked.',
      targetPath: gitignorePath,
      recommended: true,
      selected: true,
      previewTitle: '.gitignore',
      previewLines: ['# .gitignore', '', `Target: ${gitignorePath}`, '', '.ralphi/']
    });
  }

  if (!gitignoreContent.split('\n').some(line => line.trim() === '.claude/settings.local.json')) {
    items.push({
      id: 'claude-local-gitignore',
      label: 'Update .gitignore for Claude local settings',
      description: 'Ignore .claude/settings.local.json so local-only Claude settings stay untracked.',
      targetPath: gitignorePath,
      recommended: true,
      selected: true,
      previewTitle: '.gitignore',
      previewLines: ['# .gitignore', '', `Target: ${gitignorePath}`, '', '.claude/settings.local.json']
    });
  }

  if (!devcontainerConfigPath) {
    const content = await buildDevcontainerTemplate(rootDir);
    const targetPath = path.join(rootDir, '.devcontainer', 'devcontainer.json');
    items.push({
      id: 'devcontainer',
      label: 'Create a devcontainer',
      description: 'Scaffold a starter devcontainer.json so Ralphi can run in a container when requested.',
      targetPath,
      recommended: false,
      selected: false,
      previewTitle: 'devcontainer.json',
      previewLines: renderPreview('devcontainer.json', targetPath, content)
    });
  }

  return {
    items,
    devcontainerConfigPath
  };
}

export async function applyProjectBootstrap(rootDir: string, itemIds: ProjectBootstrapKind[]): Promise<ProjectBootstrapInspection> {
  const selected = new Set(itemIds);

  if (selected.has('agents-md')) {
    await writeFile(path.join(rootDir, 'AGENTS.md'), await buildAgentsTemplate(rootDir), 'utf8');
  }

  if (selected.has('claude-md')) {
    await writeFile(path.join(rootDir, 'CLAUDE.md'), await buildClaudeTemplate(rootDir), 'utf8');
  }

  if (selected.has('copilot-instructions')) {
    const targetPath = path.join(rootDir, '.github', 'copilot-instructions.md');
    await ensureDir(path.dirname(targetPath));
    await writeFile(targetPath, await buildCopilotInstructionsTemplate(rootDir), 'utf8');
  }

  if (selected.has('copilot-path-instructions')) {
    const targetPath = path.join(rootDir, '.github', 'instructions', 'code.instructions.md');
    await ensureDir(path.dirname(targetPath));
    await writeFile(targetPath, await buildCopilotPathInstructionsTemplate(rootDir), 'utf8');
  }

  if (selected.has('cursor-rules')) {
    const targetPath = path.join(rootDir, '.cursor', 'rules', 'ralphi-project.mdc');
    await ensureDir(path.dirname(targetPath));
    await writeFile(targetPath, await buildCursorRuleTemplate(rootDir), 'utf8');
  }

  if (selected.has('codex-skill-dir')) {
    const targetDir = projectProviderSkillDir(rootDir, 'codex');
    await ensureDir(targetDir);
    await writeFile(path.join(targetDir, '.gitkeep'), '', 'utf8');
  }

  if (selected.has('claude-skill-dir')) {
    const targetDir = projectProviderSkillDir(rootDir, 'claude');
    await ensureDir(targetDir);
    await writeFile(path.join(targetDir, '.gitkeep'), '', 'utf8');
  }

  if (selected.has('claude-local-gitignore')) {
    await ensureGitignoreEntries(rootDir, ['.claude/settings.local.json']);
  }

  if (selected.has('ralphi-state-gitignore')) {
    await ensureGitignoreEntries(rootDir, ['.ralphi/']);
  }

  if (selected.has('devcontainer')) {
    const targetPath = path.join(rootDir, '.devcontainer', 'devcontainer.json');
    await ensureDir(path.dirname(targetPath));
    await writeFile(targetPath, await buildDevcontainerTemplate(rootDir), 'utf8');
  }

  return inspectProjectBootstrap(rootDir);
}
