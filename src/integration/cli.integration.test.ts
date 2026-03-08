import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';

import { createTempProject } from '../test-support.js';

async function resolveCliEntry(): Promise<{ file: string; args: string[] }> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const jsEntry = path.resolve(currentDir, '..', 'cli.js');

  try {
    await access(jsEntry, constants.F_OK);
    return {
      file: jsEntry,
      args: []
    };
  } catch {
    return {
      file: path.resolve(currentDir, '..', 'cli.tsx'),
      args: ['--import=tsx']
    };
  }
}

async function runCliProcess(
  args: string[],
  options: { cwd?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const entry = await resolveCliEntry();

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...entry.args, entry.file, ...args], {
      cwd: options.cwd,
      env: process.env,
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
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

test('ralphi --help prints the usage guide', async () => {
  const result = await runCliProcess(['--help']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /ralphi prompt preview --prds file1/);
  assert.equal(result.stderr, '');
});

test('ralphi still boots when the CLI entry is launched through a symlinked bin', async () => {
  const entry = await resolveCliEntry();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ralphi-bin-'));
  const symlinkPath = path.join(tempDir, 'ralphi');

  try {
    await symlink(entry.file, symlinkPath);

    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [...entry.args, symlinkPath, '--help'], {
        env: process.env,
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
          code: code ?? 1,
          stdout,
          stderr
        });
      });
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, '');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ralphi prompt preview --create-prd materializes a draft and prints the prompt preview', async () => {
  const fixture = await createTempProject('ralphi-cli-integration-');

  try {
    const result = await runCliProcess(['prompt', 'preview', '--tool', 'codex', '--create-prd', 'Release command center'], {
      cwd: fixture.rootDir
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /=== docs\/prds\/prd-release-command-center\.md ===/);
    assert.match(result.stdout, /Planned prompt path:/);
    assert.match(result.stdout, /Instruction sources:/);
  } finally {
    await fixture.cleanup();
  }
});
