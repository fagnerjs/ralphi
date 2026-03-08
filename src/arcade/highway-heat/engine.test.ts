import test from 'node:test';
import assert from 'node:assert/strict';

import { createHighwayHeatState, moveDriver, spawnTrafficRow, stepHighwayHeat } from './engine.js';

test('moveDriver keeps the car inside the lane boundaries', () => {
  const state = createHighwayHeatState(10);
  const movedLeft = moveDriver(state, -20);
  const movedRight = moveDriver(state, 20);

  assert.equal(movedLeft.playerLane, 0);
  assert.equal(movedRight.playerLane, 4);
});

test('spawnTrafficRow only returns unique lanes inside the road', () => {
  const row = spawnTrafficRow(44, 5);

  assert.ok(row.length >= 1);
  assert.equal(new Set(row).size, row.length);
  assert.ok(row.every(lane => lane >= 0 && lane < 5));
});

test('stepHighwayHeat ends the run when traffic reaches the active lane', () => {
  const state = createHighwayHeatState(4);
  state.playerLane = 2;
  state.rows = [[], [], [], [2]];

  const next = stepHighwayHeat(state, 4);

  assert.equal(next.phase, 'gameover');
});
