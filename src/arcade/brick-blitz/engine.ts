export interface BrickBlitzState {
  phase: 'serve' | 'playing' | 'gameover' | 'cleared';
  paddleX: number;
  ballX: number;
  ballY: number;
  velocityX: number;
  velocityY: number;
  bricks: Set<string>;
  lives: number;
  score: number;
  tick: number;
}

export const brickBlitzPaddleWidth = 7;
const brickRows = 4;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function encode(x: number, y: number): string {
  return `${x}:${y}`;
}

function createBrickField(width: number): Set<string> {
  const bricks = new Set<string>();

  for (let y = 1; y <= brickRows; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      bricks.add(encode(x, y));
    }
  }

  return bricks;
}

function centeredPaddleX(width: number): number {
  return Math.max(1, Math.floor((width - brickBlitzPaddleWidth) / 2));
}

function resetBall(state: BrickBlitzState, width: number, height: number): BrickBlitzState {
  const paddleX = centeredPaddleX(width);
  const ballX = paddleX + Math.floor(brickBlitzPaddleWidth / 2);
  const ballY = height - 2;

  return {
    ...state,
    paddleX,
    ballX,
    ballY,
    velocityX: 1,
    velocityY: -1
  };
}

export function createBrickBlitzState(width: number, height: number): BrickBlitzState {
  return resetBall(
    {
      phase: 'serve',
      paddleX: centeredPaddleX(width),
      ballX: 0,
      ballY: 0,
      velocityX: 1,
      velocityY: -1,
      bricks: createBrickField(width),
      lives: 3,
      score: 0,
      tick: 0
    },
    width,
    height
  );
}

export function movePaddle(state: BrickBlitzState, delta: number, width: number): BrickBlitzState {
  if (state.phase === 'gameover' || state.phase === 'cleared') {
    return state;
  }

  return {
    ...state,
    paddleX: clamp(state.paddleX + delta, 1, Math.max(1, width - brickBlitzPaddleWidth - 1))
  };
}

export function launchBall(state: BrickBlitzState): BrickBlitzState {
  if (state.phase !== 'serve') {
    return state;
  }

  return {
    ...state,
    phase: 'playing'
  };
}

export function stepBrickBlitz(state: BrickBlitzState, width: number, height: number): BrickBlitzState {
  if (state.phase !== 'playing') {
    return state;
  }

  const nextTick = state.tick + 1;
  let velocityX = state.velocityX;
  let velocityY = state.velocityY;
  let ballX = state.ballX + velocityX;
  let ballY = state.ballY + velocityY;

  if (ballX <= 0 || ballX >= width - 1) {
    velocityX *= -1;
    ballX = state.ballX + velocityX;
  }

  if (ballY <= 0) {
    velocityY = 1;
    ballY = state.ballY + velocityY;
  }

  let bricks = state.bricks;
  let score = state.score;
  const brickKey = encode(ballX, ballY);
  if (bricks.has(brickKey)) {
    bricks = new Set(bricks);
    bricks.delete(brickKey);
    score += 25;
    velocityY *= -1;
    ballY = state.ballY + velocityY;
  }

  const paddleY = height - 1;
  if (ballY >= paddleY) {
    const paddleHit = ballY === paddleY && ballX >= state.paddleX && ballX < state.paddleX + brickBlitzPaddleWidth;
    if (paddleHit) {
      const paddleCenter = state.paddleX + Math.floor(brickBlitzPaddleWidth / 2);
      const offset = ballX - paddleCenter;
      velocityX = offset === 0 ? (velocityX >= 0 ? 1 : -1) : Math.sign(offset);
      velocityY = -1;
      ballY = paddleY - 1;
    } else {
      const lives = state.lives - 1;
      const reset = resetBall(
        {
          ...state,
          phase: lives > 0 ? 'serve' : 'gameover',
          bricks,
          lives,
          score,
          tick: nextTick
        },
        width,
        height
      );

      return reset;
    }
  }

  if (bricks.size === 0) {
    return {
      ...state,
      phase: 'cleared',
      ballX,
      ballY,
      velocityX,
      velocityY,
      bricks,
      score,
      tick: nextTick
    };
  }

  return {
    ...state,
    ballX,
    ballY,
    velocityX,
    velocityY,
    bricks,
    score,
    tick: nextTick
  };
}
