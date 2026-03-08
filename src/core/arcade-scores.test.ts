import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

import { arcadeHighScorePath, loadArcadeHighScore, loadArcadeHighScores, saveArcadeHighScore } from './arcade-scores.js';

async function createTempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'ralphi-arcade-home-'));
}

test('saveArcadeHighScore persists a per-game record under the ralphi home directory', async () => {
  const homeDir = await createTempHome();

  try {
    const saved = await saveArcadeHighScore('maze-chase', 1230, homeDir);
    const stored = await loadArcadeHighScore('maze-chase', homeDir);
    const record = JSON.parse(await readFile(arcadeHighScorePath('maze-chase', homeDir), 'utf8')) as {
      gameId: string;
      highScore: number;
    };

    assert.equal(saved, 1230);
    assert.equal(stored, 1230);
    assert.equal(record.gameId, 'maze-chase');
    assert.equal(record.highScore, 1230);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('saveArcadeHighScore keeps the best score and loadArcadeHighScores returns one score per game', async () => {
  const homeDir = await createTempHome();

  try {
    await saveArcadeHighScore('maze-chase', 450, homeDir);
    await saveArcadeHighScore('maze-chase', 320, homeDir);
    await saveArcadeHighScore('tetra-stack', 9000, homeDir);

    const scores = await loadArcadeHighScores(['maze-chase', 'tetra-stack', 'vector-pong'], homeDir);

    assert.deepEqual(scores, {
      'maze-chase': 450,
      'tetra-stack': 9000,
      'vector-pong': 0
    });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
