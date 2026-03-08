import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrickBlitzState, launchBall, movePaddle, stepBrickBlitz } from './engine.js';

test('movePaddle keeps the bat within the arena walls', () => {
  const state = createBrickBlitzState(26, 14);
  const movedLeft = movePaddle(state, -20, 26);
  const movedRight = movePaddle(state, 20, 26);

  assert.equal(movedLeft.paddleX, 1);
  assert.equal(movedRight.paddleX, 18);
});

test('stepBrickBlitz removes bricks and adds score on impact', () => {
  const serving = createBrickBlitzState(26, 14);
  const state = launchBall(serving);
  state.ballX = 5;
  state.ballY = 5;
  state.velocityX = 1;
  state.velocityY = -1;

  const next = stepBrickBlitz(state, 26, 14);

  assert.equal(next.score, 25);
  assert.equal(next.bricks.has('6:4'), false);
  assert.equal(next.velocityY, 1);
});

test('stepBrickBlitz costs a life when the ball slips past the paddle', () => {
  const serving = createBrickBlitzState(26, 14);
  const state = launchBall(serving);
  state.ballX = 1;
  state.ballY = 13;
  state.velocityX = 0;
  state.velocityY = 1;

  const next = stepBrickBlitz(state, 26, 14);

  assert.equal(next.phase, 'serve');
  assert.equal(next.lives, 2);
});
