export interface VectorPongState {
  phase: 'serve' | 'playing' | 'gameover';
  playerY: number;
  cpuY: number;
  ballX: number;
  ballY: number;
  velocityX: number;
  velocityY: number;
  score: {
    player: number;
    cpu: number;
  };
  serve: 'player' | 'cpu';
  winner: 'player' | 'cpu' | null;
  tick: number;
}

export const vectorPongPaddleSize = 3;
const winScore = 7;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function centeredPaddleY(height: number): number {
  return clamp(Math.floor(height / 2) - 1, 0, Math.max(0, height - vectorPongPaddleSize));
}

function centeredBall(width: number, height: number): { x: number; y: number } {
  return {
    x: Math.floor(width / 2),
    y: Math.floor(height / 2)
  };
}

function rallyVelocityY(tick: number): number {
  return tick % 2 === 0 ? 1 : -1;
}

function resetRally(
  state: VectorPongState,
  width: number,
  height: number,
  serve: 'player' | 'cpu',
  score = state.score
): VectorPongState {
  const nextTick = state.tick + 1;
  const winner = score.player >= winScore ? 'player' : score.cpu >= winScore ? 'cpu' : null;
  const ball = centeredBall(width, height);

  return {
    ...state,
    phase: winner ? 'gameover' : 'serve',
    playerY: centeredPaddleY(height),
    cpuY: centeredPaddleY(height),
    ballX: ball.x,
    ballY: ball.y,
    velocityX: serve === 'player' ? 1 : -1,
    velocityY: rallyVelocityY(nextTick),
    score,
    serve,
    winner,
    tick: nextTick
  };
}

export function createVectorPongState(width: number, height: number): VectorPongState {
  const centerY = centeredPaddleY(height);
  const ball = centeredBall(width, height);

  return {
    phase: 'serve',
    playerY: centerY,
    cpuY: centerY,
    ballX: ball.x,
    ballY: ball.y,
    velocityX: 1,
    velocityY: 1,
    score: {
      player: 0,
      cpu: 0
    },
    serve: 'player',
    winner: null,
    tick: 0
  };
}

export function movePlayerPaddle(state: VectorPongState, delta: number, height: number): VectorPongState {
  if (state.phase === 'gameover') {
    return state;
  }

  return {
    ...state,
    playerY: clamp(state.playerY + delta, 0, Math.max(0, height - vectorPongPaddleSize))
  };
}

export function launchServe(state: VectorPongState): VectorPongState {
  if (state.phase !== 'serve') {
    return state;
  }

  return {
    ...state,
    phase: 'playing'
  };
}

export function stepVectorPong(state: VectorPongState, width: number, height: number): VectorPongState {
  if (state.phase !== 'playing') {
    return state;
  }

  const nextTick = state.tick + 1;
  let cpuY = state.cpuY;
  if (nextTick % 2 === 0) {
    const cpuCenter = cpuY + 1;
    if (state.ballY < cpuCenter) {
      cpuY -= 1;
    } else if (state.ballY > cpuCenter) {
      cpuY += 1;
    }
    cpuY = clamp(cpuY, 0, Math.max(0, height - vectorPongPaddleSize));
  }

  let velocityX = state.velocityX;
  let velocityY = state.velocityY;
  let ballX = state.ballX + velocityX;
  let ballY = state.ballY + velocityY;

  if (ballY <= 0 || ballY >= height - 1) {
    velocityY *= -1;
    ballY = state.ballY + velocityY;
  }

  const playerPaddleX = 1;
  const cpuPaddleX = width - 2;
  if (velocityX < 0 && ballX === playerPaddleX && ballY >= state.playerY && ballY < state.playerY + vectorPongPaddleSize) {
    velocityX = 1;
    velocityY = clamp(ballY - (state.playerY + 1), -1, 1);
    ballX = playerPaddleX + 1;
  }

  if (velocityX > 0 && ballX === cpuPaddleX && ballY >= cpuY && ballY < cpuY + vectorPongPaddleSize) {
    velocityX = -1;
    velocityY = clamp(ballY - (cpuY + 1), -1, 1);
    ballX = cpuPaddleX - 1;
  }

  if (ballX < 0) {
    return resetRally(
      {
        ...state,
        cpuY,
        tick: nextTick
      },
      width,
      height,
      'player',
      {
        ...state.score,
        cpu: state.score.cpu + 1
      }
    );
  }

  if (ballX > width - 1) {
    return resetRally(
      {
        ...state,
        cpuY,
        tick: nextTick
      },
      width,
      height,
      'cpu',
      {
        ...state.score,
        player: state.score.player + 1
      }
    );
  }

  return {
    ...state,
    cpuY,
    ballX,
    ballY,
    velocityX,
    velocityY,
    tick: nextTick
  };
}
