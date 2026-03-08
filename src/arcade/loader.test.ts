import test from 'node:test';
import assert from 'node:assert/strict';

import { loadArcadeGames } from './loader.js';

test('loadArcadeGames discovers and sorts the available cabinets', async () => {
  const games = await loadArcadeGames();
  const titles = games.map(game => game.title);
  const ids = new Set(games.map(game => game.id));

  assert.ok(ids.has('asteroid-run'));
  assert.ok(ids.has('circuit-duel'));
  assert.ok(ids.has('brick-blitz'));
  assert.ok(ids.has('highway-heat'));
  assert.ok(ids.has('vector-pong'));
  assert.deepEqual(
    titles,
    [...titles].sort((left, right) => left.localeCompare(right))
  );
  assert.ok(games.every(game => game.controls.length > 0));
});
