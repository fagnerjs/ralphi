import test from 'node:test';
import assert from 'node:assert/strict';

import { createVectorPongState, launchServe, movePlayerPaddle, stepVectorPong } from './engine.js';

test('movePlayerPaddle keeps the paddle inside the court', () => {
  const state = createVectorPongState(24, 12);
  const movedUp = movePlayerPaddle(state, -20, 12);
  const movedDown = movePlayerPaddle(state, 20, 12);

  assert.equal(movedUp.playerY, 0);
  assert.equal(movedDown.playerY, 9);
});

test('stepVectorPong bounces off the player paddle', () => {
  const serving = createVectorPongState(24, 12);
  const state = launchServe(serving);
  state.playerY = 4;
  state.ballX = 2;
  state.ballY = 5;
  state.velocityX = -1;
  state.velocityY = 0;

  const next = stepVectorPong(state, 24, 12);

  assert.equal(next.velocityX, 1);
  assert.equal(next.ballX, 2);
});

test('stepVectorPong awards a point when the ball leaves the field', () => {
  const serving = createVectorPongState(24, 12);
  const state = launchServe(serving);
  state.ballX = 0;
  state.ballY = 6;
  state.velocityX = -1;
  state.velocityY = 0;

  const next = stepVectorPong(state, 24, 12);

  assert.equal(next.phase, 'serve');
  assert.equal(next.score.cpu, 1);
  assert.equal(next.serve, 'player');
});
