import path from 'node:path';

import { ralphiHomeDir } from './project.js';
import { ensureDir, parseJsonFile, writeJsonFile } from './utils.js';

const ARCADE_HIGH_SCORE_VERSION = 1;

interface ArcadeHighScoreRecord {
  version: number;
  gameId: string;
  highScore: number;
  updatedAt: string;
}

function normalizeScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }

  return Math.max(0, Math.floor(score));
}

export function arcadeHighScoreDir(homeDir = ralphiHomeDir()): string {
  return path.join(homeDir, 'arcade', 'high-scores');
}

export function arcadeHighScorePath(gameId: string, homeDir = ralphiHomeDir()): string {
  return path.join(arcadeHighScoreDir(homeDir), `${gameId}.json`);
}

export async function loadArcadeHighScore(gameId: string, homeDir = ralphiHomeDir()): Promise<number> {
  const parsed = await parseJsonFile<ArcadeHighScoreRecord>(arcadeHighScorePath(gameId, homeDir));
  if (parsed?.version !== ARCADE_HIGH_SCORE_VERSION || parsed.gameId !== gameId) {
    return 0;
  }

  return normalizeScore(parsed.highScore);
}

export async function loadArcadeHighScores(gameIds: string[], homeDir = ralphiHomeDir()): Promise<Record<string, number>> {
  const uniqueIds = [...new Set(gameIds.filter(Boolean))];
  const entries = await Promise.all(uniqueIds.map(async gameId => [gameId, await loadArcadeHighScore(gameId, homeDir)] as const));
  return Object.fromEntries(entries);
}

export async function saveArcadeHighScore(gameId: string, score: number, homeDir = ralphiHomeDir()): Promise<number> {
  const nextScore = normalizeScore(score);
  if (!gameId.trim()) {
    throw new Error('Arcade high scores require a game id.');
  }

  const current = await loadArcadeHighScore(gameId, homeDir);
  if (nextScore <= current) {
    return current;
  }

  await ensureDir(arcadeHighScoreDir(homeDir));
  await writeJsonFile(arcadeHighScorePath(gameId, homeDir), {
    version: ARCADE_HIGH_SCORE_VERSION,
    gameId,
    highScore: nextScore,
    updatedAt: new Date().toISOString()
  } satisfies ArcadeHighScoreRecord);

  return nextScore;
}
