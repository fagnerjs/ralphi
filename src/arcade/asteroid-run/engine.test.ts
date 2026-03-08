import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAsteroidRunState,
  fireLaser,
  moveShip,
  spawnIntervalForLevel,
  spawnRocks,
  stepAsteroidRun
} from './engine.js';

test('moveShip keeps the ship inside the visible field', () => {
  const initial = createAsteroidRunState(12);
  const left = moveShip({ ...initial, shipX: 0 }, 12, -3);
  const right = moveShip({ ...initial, shipX: 11 }, 12, 4);

  assert.equal(left.shipX, 0);
  assert.equal(right.shipX, 11);
});

test('fireLaser avoids stacking duplicate launch shots in the same lane', () => {
  const initial = createAsteroidRunState(14);
  const fired = fireLaser(initial, 10);
  const blocked = fireLaser(fired, 10);

  assert.equal(fired.lasers.length, 1);
  assert.equal(blocked.lasers.length, 1);
});

test('stepAsteroidRun scores when a laser clips a rock', () => {
  const next = stepAsteroidRun(
    {
      phase: 'playing',
      shipX: 5,
      rocks: [{ x: 5, y: 4, dx: 0, glyph: 'o' }],
      lasers: [{ x: 5, y: 5 }],
      score: 0,
      lives: 3,
      level: 1,
      tick: 0
    },
    12,
    10
  );

  assert.equal(next.score, 25);
  assert.equal(next.rocks.length, 0);
  assert.equal(next.lasers.length, 0);
});

test('stepAsteroidRun strips a life and resets the wave when the belt breaches the hull', () => {
  const next = stepAsteroidRun(
    {
      phase: 'playing',
      shipX: 5,
      rocks: [{ x: 5, y: 8, dx: 0, glyph: 'O' }],
      lasers: [],
      score: 125,
      lives: 3,
      level: 1,
      tick: 0
    },
    12,
    10
  );

  assert.equal(next.lives, 2);
  assert.equal(next.rocks.length, 0);
  assert.equal(next.lasers.length, 0);
  assert.equal(next.phase, 'playing');
});

test('spawnRocks keeps generated rocks unique and inside the board', () => {
  const rocks = spawnRocks(18, 4, 12);

  assert.equal(rocks.length, 2);
  assert.equal(new Set(rocks.map(rock => rock.x)).size, rocks.length);
  assert.ok(rocks.every(rock => rock.x >= 0 && rock.x < 18));
  assert.equal(spawnIntervalForLevel(4), 5);
});
