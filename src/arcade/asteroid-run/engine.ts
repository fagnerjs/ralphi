export type Drift = -1 | 0 | 1;
export type RockGlyph = 'o' | 'O';

export interface Rock {
  x: number;
  y: number;
  dx: Drift;
  glyph: RockGlyph;
}

export interface Laser {
  x: number;
  y: number;
}

export interface AsteroidRunState {
  phase: 'playing' | 'gameover';
  shipX: number;
  rocks: Rock[];
  lasers: Laser[];
  score: number;
  lives: number;
  level: number;
  tick: number;
}

const driftOptions: Drift[] = [-1, 0, 1];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function centerShip(width: number): number {
  return Math.max(0, Math.floor(width / 2));
}

export function spawnIntervalForLevel(level: number): number {
  return Math.max(2, 8 - Math.min(5, level - 1));
}

export function spawnRocks(width: number, level: number, tick: number): Rock[] {
  const safeWidth = Math.max(8, width);
  const spawnCount = Math.min(3, 1 + Math.floor((level - 1) / 2));
  const used = new Set<number>();
  const rocks: Rock[] = [];

  for (let index = 0; index < spawnCount; index += 1) {
    const seed = tick * 29 + level * 17 + index * 11;
    let x = Math.abs(seed) % safeWidth;

    while (used.has(x)) {
      x = (x + 5) % safeWidth;
    }

    used.add(x);
    const dx = driftOptions[Math.abs(seed + index * 7) % driftOptions.length] ?? 0;
    rocks.push({
      x,
      y: 0,
      dx,
      glyph: Math.abs(seed) % 4 === 0 ? 'O' : 'o'
    });
  }

  return rocks;
}

export function createAsteroidRunState(width: number): AsteroidRunState {
  return {
    phase: 'playing',
    shipX: centerShip(width),
    rocks: [],
    lasers: [],
    score: 0,
    lives: 3,
    level: 1,
    tick: 0
  };
}

export function moveShip(state: AsteroidRunState, width: number, delta: number): AsteroidRunState {
  if (state.phase !== 'playing') {
    return state;
  }

  return {
    ...state,
    shipX: clamp(state.shipX + delta, 0, Math.max(0, width - 1))
  };
}

export function fireLaser(state: AsteroidRunState, height: number): AsteroidRunState {
  if (state.phase !== 'playing') {
    return state;
  }

  const launchY = Math.max(0, height - 2);
  if (state.lasers.some(laser => laser.x === state.shipX && laser.y >= launchY - 1)) {
    return state;
  }

  return {
    ...state,
    lasers: [...state.lasers, { x: state.shipX, y: launchY }]
  };
}

function resolveHits(lasers: Laser[], rocks: Rock[]): { lasers: Laser[]; rocks: Rock[]; hits: number } {
  const destroyedRocks = new Set<number>();
  const nextLasers: Laser[] = [];
  let hits = 0;

  for (const laser of lasers) {
    const hitIndex = rocks.findIndex(
      (rock, index) => !destroyedRocks.has(index) && rock.x === laser.x && rock.y === laser.y
    );

    if (hitIndex >= 0) {
      destroyedRocks.add(hitIndex);
      hits += 1;
      continue;
    }

    nextLasers.push(laser);
  }

  return {
    lasers: nextLasers,
    rocks: rocks.filter((_, index) => !destroyedRocks.has(index)),
    hits
  };
}

function moveRocks(rocks: Rock[], width: number, tick: number): Rock[] {
  const shouldDrift = tick % 2 === 0;

  return rocks.map(rock => {
    let x = rock.x;
    let dx = rock.dx;

    if (shouldDrift && dx !== 0) {
      const candidate = x + dx;
      if (candidate < 0 || candidate >= width) {
        dx = dx === 1 ? -1 : 1;
        x = clamp(candidate, 0, Math.max(0, width - 1));
      } else {
        x = candidate;
      }
    }

    return {
      ...rock,
      x,
      y: rock.y + 1,
      dx
    };
  });
}

export function stepAsteroidRun(state: AsteroidRunState, width: number, height: number): AsteroidRunState {
  if (state.phase !== 'playing') {
    return state;
  }

  const tick = state.tick + 1;
  const movedLasers = state.lasers
    .map(laser => ({
      ...laser,
      y: laser.y - 1
    }))
    .filter(laser => laser.y >= 0);

  const preMoveHits = resolveHits(movedLasers, state.rocks);
  const movedRocks = moveRocks(preMoveHits.rocks, width, tick);
  const postMoveHits = resolveHits(preMoveHits.lasers, movedRocks);
  const score = state.score + (preMoveHits.hits + postMoveHits.hits) * 25;
  const level = 1 + Math.floor(score / 150);
  const spawnInterval = spawnIntervalForLevel(level);
  const spawnedRocks = tick % spawnInterval === 0 ? spawnRocks(width, level, tick) : [];
  const rocks = [...postMoveHits.rocks, ...spawnedRocks];
  const breach = rocks.some(rock => rock.y >= height - 1);

  if (breach) {
    if (state.lives <= 1) {
      return {
        ...state,
        phase: 'gameover',
        shipX: centerShip(width),
        rocks: [],
        lasers: [],
        score,
        lives: 0,
        level,
        tick
      };
    }

    return {
      ...state,
      shipX: centerShip(width),
      rocks: [],
      lasers: [],
      score,
      lives: state.lives - 1,
      level,
      tick
    };
  }

  return {
    ...state,
    rocks,
    lasers: postMoveHits.lasers,
    score,
    level,
    tick
  };
}
