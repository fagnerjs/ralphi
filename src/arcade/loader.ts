import path from 'node:path';
import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ArcadeGameDefinition, ArcadeGameModule } from './types.js';

const entryCandidates = ['index.js', 'index.tsx', 'index.ts', 'index.jsx'];

let gameCachePromise: Promise<ArcadeGameDefinition[]> | null = null;

function arcadeRootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)));
}

async function resolveEntryFile(gameDir: string): Promise<string | null> {
  for (const candidate of entryCandidates) {
    const targetPath = path.join(gameDir, candidate);
    try {
      await access(targetPath, constants.F_OK);
      return targetPath;
    } catch {
      continue;
    }
  }

  return null;
}

function isArcadeGameDefinition(value: unknown): value is ArcadeGameDefinition {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ArcadeGameDefinition>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.year === 'string' &&
    typeof candidate.tagline === 'string' &&
    typeof candidate.description === 'string' &&
    Array.isArray(candidate.marquee) &&
    Array.isArray(candidate.controls) &&
    typeof candidate.component === 'function'
  );
}

export async function loadArcadeGames(): Promise<ArcadeGameDefinition[]> {
  if (gameCachePromise) {
    return gameCachePromise;
  }

  gameCachePromise = (async () => {
    const rootDir = arcadeRootDir();
    const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
    const games: ArcadeGameDefinition[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const gameDir = path.join(rootDir, entry.name);
      const entryFile = await resolveEntryFile(gameDir);
      if (!entryFile) {
        continue;
      }

      try {
        const loaded = (await import(pathToFileURL(entryFile).href)) as ArcadeGameModule;
        if (isArcadeGameDefinition(loaded.default)) {
          games.push(loaded.default);
        }
      } catch {
        continue;
      }
    }

    return games.sort((left, right) => left.title.localeCompare(right.title));
  })();

  return gameCachePromise;
}
