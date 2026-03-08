#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.join(scriptDir, '..', 'docs', 'media');
const keepFile = path.join(mediaDir, '.gitkeep');

async function main() {
  await mkdir(mediaDir, { recursive: true });
  await writeFile(keepFile, '', 'utf8');

  process.stdout.write(`Ralphi docs media directory is ready: ${mediaDir}\n`);
  process.stdout.write('Add static images manually when publishing the README.\n');
  process.stdout.write('Expected files: ralphi-hero.png, ralphi-backlog.png, ralphi-live.png, ralphi-arcade-select.png, ralphi-arcade-game.png\n');
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
