export interface HighwayHeatState {
  phase: 'playing' | 'gameover';
  playerLane: number;
  rows: number[][];
  score: number;
  level: number;
  tick: number;
}

export const highwayHeatLaneCount = 5;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function uniqueLanes(lanes: number[]): number[] {
  return [...new Set(lanes.filter(lane => lane >= 0 && lane < highwayHeatLaneCount))].sort((left, right) => left - right);
}

export function createHighwayHeatState(roadHeight: number): HighwayHeatState {
  return {
    phase: 'playing',
    playerLane: Math.floor(highwayHeatLaneCount / 2),
    rows: Array.from({ length: roadHeight }, () => []),
    score: 0,
    level: 1,
    tick: 0
  };
}

export function moveDriver(state: HighwayHeatState, delta: number): HighwayHeatState {
  if (state.phase !== 'playing') {
    return state;
  }

  return {
    ...state,
    playerLane: clamp(state.playerLane + delta, 0, highwayHeatLaneCount - 1)
  };
}

export function spawnTrafficRow(tick: number, level: number): number[] {
  const first = (tick * 3 + level) % highwayHeatLaneCount;
  const second = (first + 2 + (level % 2)) % highwayHeatLaneCount;

  if (level >= 4 && tick % 11 === 0) {
    return uniqueLanes([first, second]);
  }

  if (tick % 9 === 0) {
    return uniqueLanes([first, second]);
  }

  return [first];
}

export function stepHighwayHeat(state: HighwayHeatState, roadHeight: number): HighwayHeatState {
  if (state.phase !== 'playing') {
    return state;
  }

  const collisionRow = state.rows[roadHeight - 1] ?? [];
  if (collisionRow.includes(state.playerLane)) {
    return {
      ...state,
      phase: 'gameover',
      tick: state.tick + 1
    };
  }

  const tick = state.tick + 1;
  const level = 1 + Math.floor(tick / 18);
  const nextRow = spawnTrafficRow(tick, level);

  return {
    ...state,
    rows: [nextRow, ...state.rows.slice(0, Math.max(roadHeight - 1, 0))],
    score: state.score + level * 10,
    level,
    tick
  };
}
