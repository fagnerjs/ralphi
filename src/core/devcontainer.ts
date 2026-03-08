import { spawn } from 'node:child_process';
import path from 'node:path';

import { findExecutable, pathExists } from './utils.js';

export async function findDevcontainerConfig(rootDir: string): Promise<string | null> {
  const candidates = [
    path.join(rootDir, '.devcontainer', 'devcontainer.json'),
    path.join(rootDir, '.devcontainer.json')
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function findDevcontainerExecutable(): Promise<string | null> {
  return findExecutable('devcontainer');
}

interface DevcontainerCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runDevcontainerCommand(
  workspaceDir: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<DevcontainerCommandResult> {
  const executable = await findDevcontainerExecutable();
  if (!executable) {
    throw new Error('The Dev Container CLI (`devcontainer`) was not found in PATH.');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: workspaceDir,
      env,
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

export async function ensureDevcontainerWorkspace(workspaceDir: string): Promise<void> {
  const result = await runDevcontainerCommand(workspaceDir, ['up', '--workspace-folder', workspaceDir]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Unable to start the devcontainer for ${workspaceDir}.`);
  }
}
