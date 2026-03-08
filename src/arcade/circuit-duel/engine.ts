export type CycleDirection = 'up' | 'down' | 'left' | 'right';
export type CycleOwner = 'player' | 'rival';
export type CycleOutcome = CycleOwner | 'draw' | null;

export interface Position {
  x: number;
  y: number;
}

export interface CycleBike {
  head: Position;
  direction: CycleDirection;
}

export interface TrailCell extends Position {
  owner: CycleOwner;
}

export interface CircuitDuelState {
  phase: 'playing' | 'round-over' | 'gameover';
  player: CycleBike;
  rival: CycleBike;
  trail: TrailCell[];
  occupied: Set<string>;
  score: {
    player: number;
    rival: number;
  };
  round: number;
  tick: number;
  outcome: CycleOutcome;
}

const winScore = 5;

const leftTurn: Record<CycleDirection, CycleDirection> = {
  up: 'left',
  left: 'down',
  down: 'right',
  right: 'up'
};

const rightTurn: Record<CycleDirection, CycleDirection> = {
  up: 'right',
  right: 'down',
  down: 'left',
  left: 'up'
};

const oppositeDirection: Record<CycleDirection, CycleDirection> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left'
};

const vectors: Record<CycleDirection, Position> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};

function encode(position: Position): string {
  return `${position.x}:${position.y}`;
}

function inBounds(position: Position, width: number, height: number): boolean {
  return position.x >= 0 && position.x < width && position.y >= 0 && position.y < height;
}

function move(position: Position, direction: CycleDirection): Position {
  const vector = vectors[direction];
  return {
    x: position.x + vector.x,
    y: position.y + vector.y
  };
}

function countRunway(
  origin: Position,
  direction: CycleDirection,
  occupied: Set<string>,
  width: number,
  height: number
): number {
  let steps = 0;
  let current = origin;

  while (steps < Math.max(width, height)) {
    current = move(current, direction);
    if (!inBounds(current, width, height) || occupied.has(encode(current))) {
      return steps;
    }
    steps += 1;
  }

  return steps;
}

export function createCircuitDuelState(width: number, height: number): CircuitDuelState {
  const centerY = Math.max(0, Math.floor(height / 2));
  const playerHead = { x: Math.max(1, Math.floor(width * 0.2)), y: centerY };
  const rivalHead = { x: Math.max(2, Math.min(width - 2, Math.floor(width * 0.8))), y: centerY };
  const trail: TrailCell[] = [
    { ...playerHead, owner: 'player' },
    { ...rivalHead, owner: 'rival' }
  ];

  return {
    phase: 'playing',
    player: {
      head: playerHead,
      direction: 'right'
    },
    rival: {
      head: rivalHead,
      direction: 'left'
    },
    trail,
    occupied: new Set(trail.map(cell => encode(cell))),
    score: {
      player: 0,
      rival: 0
    },
    round: 1,
    tick: 0,
    outcome: null
  };
}

export function setPlayerDirection(state: CircuitDuelState, direction: CycleDirection): CircuitDuelState {
  if (state.phase !== 'playing' || direction === state.player.direction || direction === oppositeDirection[state.player.direction]) {
    return state;
  }

  return {
    ...state,
    player: {
      ...state.player,
      direction
    }
  };
}

export function chooseRivalDirection(state: CircuitDuelState, width: number, height: number): CycleDirection {
  const directions: CycleDirection[] = [
    state.rival.direction,
    leftTurn[state.rival.direction],
    rightTurn[state.rival.direction]
  ];

  let bestDirection = state.rival.direction;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const direction of directions) {
    const next = move(state.rival.head, direction);
    if (!inBounds(next, width, height) || state.occupied.has(encode(next))) {
      continue;
    }

    const runway = countRunway(next, direction, state.occupied, width, height);
    const distanceToPlayer = Math.abs(next.x - state.player.head.x) + Math.abs(next.y - state.player.head.y);
    const score = runway * 6 - distanceToPlayer + (direction === state.rival.direction ? 1 : 0);

    if (score > bestScore) {
      bestScore = score;
      bestDirection = direction;
    }
  }

  return bestDirection;
}

export function stepCircuitDuel(state: CircuitDuelState, width: number, height: number): CircuitDuelState {
  if (state.phase !== 'playing') {
    return state;
  }

  const tick = state.tick + 1;
  const rivalDirection = chooseRivalDirection(state, width, height);
  const nextPlayerHead = move(state.player.head, state.player.direction);
  const nextRivalHead = move(state.rival.head, rivalDirection);
  const sameCell = nextPlayerHead.x === nextRivalHead.x && nextPlayerHead.y === nextRivalHead.y;
  const playerCrash = sameCell || !inBounds(nextPlayerHead, width, height) || state.occupied.has(encode(nextPlayerHead));
  const rivalCrash = sameCell || !inBounds(nextRivalHead, width, height) || state.occupied.has(encode(nextRivalHead));

  if (playerCrash || rivalCrash) {
    const outcome: CycleOutcome = playerCrash && rivalCrash ? 'draw' : playerCrash ? 'rival' : 'player';
    const score = {
      player: state.score.player + (outcome === 'player' ? 1 : 0),
      rival: state.score.rival + (outcome === 'rival' ? 1 : 0)
    };
    const phase = outcome !== 'draw' && (score.player >= winScore || score.rival >= winScore) ? 'gameover' : 'round-over';

    return {
      ...state,
      phase,
      score,
      tick,
      outcome,
      rival: {
        ...state.rival,
        direction: rivalDirection
      }
    };
  }

  const trail: TrailCell[] = [
    ...state.trail,
    { ...nextPlayerHead, owner: 'player' },
    { ...nextRivalHead, owner: 'rival' }
  ];
  const occupied = new Set(state.occupied);
  occupied.add(encode(nextPlayerHead));
  occupied.add(encode(nextRivalHead));

  return {
    ...state,
    player: {
      head: nextPlayerHead,
      direction: state.player.direction
    },
    rival: {
      head: nextRivalHead,
      direction: rivalDirection
    },
    trail,
    occupied,
    tick
  };
}

export function startNextRound(state: CircuitDuelState, width: number, height: number): CircuitDuelState {
  const next = createCircuitDuelState(width, height);

  return {
    ...next,
    score: { ...state.score },
    round: state.round + 1
  };
}
