#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(scriptDir, '..', 'dist');
const ignorePath = path.join(distDir, '.npmignore');
const ignoreLines = ['**/*.test.js', '**/*.test.d.ts', 'integration/', 'test-support.js', 'test-support.d.ts'];

async function main() {
  await mkdir(distDir, { recursive: true });
  await writeFile(ignorePath, `${ignoreLines.join('\n')}\n`, 'utf8');
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
