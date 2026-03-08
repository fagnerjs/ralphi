import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseRivalDirection,
  createCircuitDuelState,
  setPlayerDirection,
  startNextRound,
  stepCircuitDuel
} from './engine.js';

test('setPlayerDirection rejects an immediate reversal', () => {
  const state = createCircuitDuelState(20, 10);
  const reversed = setPlayerDirection(state, 'left');

  assert.equal(reversed.player.direction, 'right');
});

test('chooseRivalDirection avoids a blocked forward lane', () => {
  const state = createCircuitDuelState(20, 12);
  state.occupied.add('15:6');
  state.occupied.add('16:6');

  const direction = chooseRivalDirection(state, 20, 12);

  assert.notEqual(direction, 'left');
});

test('stepCircuitDuel awards the round when the rival hits the wall first', () => {
  const state = createCircuitDuelState(12, 8);
  state.player.direction = 'up';
  state.player.head = { x: 4, y: 4 };
  state.rival.direction = 'right';
  state.rival.head = { x: 11, y: 4 };
  state.trail = [
    { x: 4, y: 4, owner: 'player' },
    { x: 11, y: 4, owner: 'rival' },
    { x: 11, y: 3, owner: 'player' },
    { x: 11, y: 5, owner: 'player' }
  ];
  state.occupied = new Set(['4:4', '11:4', '11:3', '11:5']);

  const next = stepCircuitDuel(state, 12, 8);

  assert.equal(next.phase, 'round-over');
  assert.equal(next.outcome, 'player');
  assert.equal(next.score.player, 1);
});

test('stepCircuitDuel detects head-on collisions as a draw', () => {
  const state = createCircuitDuelState(20, 10);
  state.player.head = { x: 9, y: 5 };
  state.player.direction = 'right';
  state.rival.head = { x: 11, y: 5 };
  state.rival.direction = 'left';
  state.trail = [
    { x: 9, y: 5, owner: 'player' },
    { x: 11, y: 5, owner: 'rival' },
    { x: 11, y: 4, owner: 'player' },
    { x: 11, y: 6, owner: 'player' }
  ];
  state.occupied = new Set(['9:5', '11:5', '11:4', '11:6']);

  const next = stepCircuitDuel(state, 20, 10);

  assert.equal(next.phase, 'round-over');
  assert.equal(next.outcome, 'draw');
  assert.equal(next.score.player, 0);
  assert.equal(next.score.rival, 0);
});

test('startNextRound keeps the match score while rebuilding the grid', () => {
  const state = createCircuitDuelState(20, 10);
  state.phase = 'round-over';
  state.score.player = 2;
  state.score.rival = 1;

  const next = startNextRound(state, 20, 10);

  assert.equal(next.phase, 'playing');
  assert.deepEqual(next.score, { player: 2, rival: 1 });
  assert.equal(next.round, 2);
  assert.equal(next.trail.length, 2);
});
