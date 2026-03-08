import { access, constants } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { findDevcontainerExecutable } from './devcontainer.js';
import { inspectGitWorkspace } from './git.js';
import { globalProviderSkillDir, projectProviderSkillDir, projectSkillDir, providerExecutableName } from './project.js';
import type { DoctorCheck, DoctorCheckStatus, DoctorReport, RalphConfig } from './types.js';
import { findExecutable, parseJsonFile, pathExists } from './utils.js';

async function probeCommandVersion(command: string, cwd: string): Promise<string | null> {
  const attempts: string[][] = [['--version'], ['version'], ['-v']];

  for (const args of attempts) {
    const result = await new Promise<{ stdout: string; stderr: string; code: number }>(resolve => {
      const child = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, 5000);

      child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8');
      });

      child.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', () => {
        clearTimeout(timer);
        resolve({
          stdout: '',
          stderr: '',
          code: 1
        });
      });

      child.on('close', code => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          code: code ?? 1
        });
      });
    });

    if (result.code === 0) {
      const firstLine = `${result.stdout}\n${result.stderr}`
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean);
      if (firstLine) {
        return firstLine;
      }
    }
  }

  return null;
}

function overallStatus(checks: DoctorCheck[]): DoctorCheckStatus {
  if (checks.some(check => check.status === 'blocking')) {
    return 'blocking';
  }

  if (checks.some(check => check.status === 'warning')) {
    return 'warning';
  }

  return 'ok';
}

function countStatuses(checks: DoctorCheck[]): Record<DoctorCheckStatus, number> {
  return checks.reduce<Record<DoctorCheckStatus, number>>(
    (counts, check) => {
      counts[check.status] += 1;
      return counts;
    },
    {
      ok: 0,
      warning: 0,
      blocking: 0
    }
  );
}

async function fileWritable(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(config: RalphConfig): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const providerExecutable = await findExecutable(providerExecutableName(config.tool));

  if (!providerExecutable) {
    checks.push({
      id: 'provider',
      label: 'Provider',
      status: 'blocking',
      summary: `Provider "${config.tool}" was not found in PATH.`,
      detail: 'Install the CLI or fix PATH before launching the loop.'
    });
  } else {
    const version = await probeCommandVersion(providerExecutable, config.rootDir);
    checks.push({
      id: 'provider',
      label: 'Provider',
      status: 'ok',
      summary: version ? `${config.tool} detected (${version}).` : `${config.tool} detected. Version probe was unavailable.`,
      detail: providerExecutable
    });
  }

  if (config.executionEnvironment === 'devcontainer') {
    const devcontainerExecutable = await findDevcontainerExecutable();
    const status = config.devcontainerConfigPath && devcontainerExecutable ? 'ok' : 'blocking';
    checks.push({
      id: 'execution-environment',
      label: 'Execution environment',
      status,
      summary:
        status === 'ok'
          ? `Devcontainer mode is ready (${path.basename(config.devcontainerConfigPath ?? 'devcontainer.json')}).`
          : !config.devcontainerConfigPath
            ? 'Devcontainer mode is selected, but no devcontainer.json was found.'
            : 'Devcontainer mode is selected, but the `devcontainer` CLI was not found in PATH.',
      detail: config.devcontainerConfigPath ?? devcontainerExecutable ?? null
    });
  } else {
    checks.push({
      id: 'execution-environment',
      label: 'Execution environment',
      status: 'ok',
      summary: 'Local execution is selected.',
      detail: null
    });
  }

  const gitValidation = await inspectGitWorkspace(config.rootDir);
  checks.push({
    id: 'git',
    label: 'Git repository',
    status: !gitValidation.repository ? (config.workspaceStrategy === 'worktree' ? 'blocking' : 'warning') : gitValidation.clean ? 'ok' : 'warning',
    summary: !gitValidation.repository
      ? config.workspaceStrategy === 'worktree'
        ? 'Worktree mode requires a Git repository.'
        : 'Git repository not detected. Ralphi will stay in the shared workspace.'
      : gitValidation.clean
        ? `Git root detected on ${gitValidation.currentBranch ?? 'detached HEAD'}.`
        : `Git root detected on ${gitValidation.currentBranch ?? 'detached HEAD'} with local changes.`,
    detail: gitValidation.repository ? gitValidation.rootDir : null
  });

  checks.push({
    id: 'worktree-root',
    label: 'Worktree root',
    status: config.workspaceStrategy === 'shared' || gitValidation.repository ? 'ok' : 'warning',
    summary:
      config.workspaceStrategy === 'shared'
        ? 'Shared workspace mode is selected.'
        : gitValidation.repository
          ? `Managed worktrees will live under ${gitValidation.worktreeRoot}.`
          : 'Managed worktrees are unavailable until Git is initialized.',
    detail: gitValidation.worktreeRoot
  });

  const rawProjectConfig = await parseJsonFile<unknown>(config.projectConfigPath);
  const configExists = await pathExists(config.projectConfigPath);
  checks.push({
    id: 'project-config',
    label: '.ralphi.json',
    status: !configExists || config.projectConfigCreated ? 'warning' : rawProjectConfig ? 'ok' : 'blocking',
    summary: !configExists
      ? '.ralphi.json is missing. Ralphi will fall back to defaults.'
      : config.projectConfigCreated
        ? '.ralphi.json was created from defaults for this workspace.'
      : rawProjectConfig
        ? '.ralphi.json loaded successfully.'
        : '.ralphi.json is present but could not be parsed.',
    detail: config.projectConfigPath
  });

  const skillRoots = Array.from(
    new Set([
      projectSkillDir(config.rootDir),
      projectProviderSkillDir(config.rootDir, 'amp'),
      projectProviderSkillDir(config.rootDir, 'codex'),
      projectProviderSkillDir(config.rootDir, 'claude'),
      projectProviderSkillDir(config.rootDir, 'copilot'),
      projectProviderSkillDir(config.rootDir, 'opencode'),
      projectProviderSkillDir(config.rootDir, 'qwen'),
      globalProviderSkillDir('amp'),
      globalProviderSkillDir('codex'),
      globalProviderSkillDir('claude'),
      globalProviderSkillDir('copilot'),
      globalProviderSkillDir('opencode'),
      globalProviderSkillDir('qwen')
    ])
  );
  const existingRoots = (await Promise.all(skillRoots.map(async root => ((await pathExists(root)) ? root : null)))).filter(
    (root): root is string => Boolean(root)
  );
  const missingExecutionSkills = (
    await Promise.all(config.executionSkills.map(async skill => ((await pathExists(skill.sourcePath)) ? null : skill.name)))
  ).filter((name): name is string => Boolean(name));

  checks.push({
    id: 'skills',
    label: 'Skill roots',
    status: missingExecutionSkills.length > 0 ? 'blocking' : existingRoots.length > 0 ? 'ok' : 'warning',
    summary:
      missingExecutionSkills.length > 0
        ? `Missing execution skill sources: ${missingExecutionSkills.join(', ')}.`
        : existingRoots.length > 0
          ? `${existingRoots.length} skill root${existingRoots.length === 1 ? '' : 's'} detected.`
          : 'No local skill roots were detected yet.',
    detail: missingExecutionSkills.length > 0 ? missingExecutionSkills.join(', ') : existingRoots.slice(0, 4).join(', ') || null
  });

  const prdMissing = (
    await Promise.all(config.plans.map(async plan => ((await pathExists(plan.sourcePrd)) ? null : plan.sourcePrd)))
  ).filter((entry): entry is string => Boolean(entry));

  checks.push({
    id: 'workspace',
    label: 'Workspace',
    status: prdMissing.length > 0 ? 'blocking' : (await fileWritable(config.rootDir)) ? 'ok' : 'warning',
    summary:
      prdMissing.length > 0
        ? `Missing PRD input${prdMissing.length === 1 ? '' : 's'}: ${prdMissing.map(entry => path.basename(entry)).join(', ')}.`
        : `Workspace root is ${config.rootDir}.`,
    detail: config.ralphDir
  });

  return {
    generatedAt: new Date().toISOString(),
    status: overallStatus(checks),
    checks,
    counts: countStatuses(checks)
  };
}

export function doctorSummaryLine(report: DoctorReport): string {
  return `${report.counts.ok} ok · ${report.counts.warning} warning · ${report.counts.blocking} blocking`;
}
