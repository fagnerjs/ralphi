import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { ArcadeGameDefinition, ArcadeGameProps } from '../types.js';
import { HintLine } from '../../ui/components.js';
import { palette } from '../../ui/theme.js';

type ArcadePhase = 'playing' | 'gameover';

interface Invader {
  x: number;
  y: number;
}

interface Shot {
  x: number;
  y: number;
}

interface ArcadeState {
  phase: ArcadePhase;
  playerX: number;
  invaders: Invader[];
  shots: Shot[];
  direction: -1 | 1;
  tick: number;
  score: number;
  lives: number;
  level: number;
}

interface RowSegment {
  text: string;
  color: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createInvaders(width: number, level: number): Invader[] {
  const rows = Math.min(5, 3 + Math.floor((level - 1) / 2));
  const columns = Math.min(10, 6 + ((level - 1) % 4));
  const spacing = 3;
  const formationWidth = columns * spacing - 1;
  const startX = Math.max(1, Math.floor((width - formationWidth) / 2));
  const invaders: Invader[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      invaders.push({
        x: startX + column * spacing,
        y: 1 + row * 2
      });
    }
  }

  return invaders;
}

function createArcadeState(width: number): ArcadeState {
  return {
    phase: 'playing',
    playerX: Math.floor(width / 2),
    invaders: createInvaders(width, 1),
    shots: [],
    direction: 1,
    tick: 0,
    score: 0,
    lives: 3,
    level: 1
  };
}

function resetWave(state: ArcadeState, width: number): ArcadeState {
  return {
    ...state,
    playerX: Math.floor(width / 2),
    invaders: createInvaders(width, state.level),
    shots: [],
    direction: 1
  };
}

function resolveHits(shots: Shot[], invaders: Invader[]): { shots: Shot[]; invaders: Invader[]; hits: number } {
  const hitKeys = new Set<string>();
  const nextShots: Shot[] = [];
  let hits = 0;

  for (const shot of shots) {
    const hitIndex = invaders.findIndex(invader => invader.x === shot.x && invader.y === shot.y);
    if (hitIndex >= 0) {
      hitKeys.add(`${invaders[hitIndex].x}:${invaders[hitIndex].y}`);
      hits += 1;
      continue;
    }

    nextShots.push(shot);
  }

  return {
    shots: nextShots,
    invaders: invaders.filter(invader => !hitKeys.has(`${invader.x}:${invader.y}`)),
    hits
  };
}

function fireShot(state: ArcadeState, height: number): ArcadeState {
  if (state.phase !== 'playing') {
    return state;
  }

  const nextY = height - 2;
  if (state.shots.length >= 3 || state.shots.some(shot => shot.x === state.playerX && shot.y >= nextY - 1)) {
    return state;
  }

  return {
    ...state,
    shots: [...state.shots, { x: state.playerX, y: nextY }]
  };
}

function stepArcade(state: ArcadeState, width: number, height: number): ArcadeState {
  if (state.phase !== 'playing') {
    return state;
  }

  const tick = state.tick + 1;
  let shots = state.shots
    .map(shot => ({ ...shot, y: shot.y - 1 }))
    .filter(shot => shot.y >= 0);
  let invaders = state.invaders;
  let score = state.score;
  let direction = state.direction;

  const hitBeforeMove = resolveHits(shots, invaders);
  shots = hitBeforeMove.shots;
  invaders = hitBeforeMove.invaders;
  score += hitBeforeMove.hits * 10;

  const moveInterval = Math.max(2, 6 - Math.min(4, state.level - 1));
  if (invaders.length > 0 && tick % moveInterval === 0) {
    const willHitEdge = invaders.some(invader => invader.x + direction <= 0 || invader.x + direction >= width - 1);
    invaders = invaders.map(invader =>
      willHitEdge
        ? {
            ...invader,
            y: invader.y + 1
          }
        : {
            ...invader,
            x: invader.x + direction
          }
    );
    direction = willHitEdge ? (direction === 1 ? -1 : 1) : direction;
  }

  const hitAfterMove = resolveHits(shots, invaders);
  shots = hitAfterMove.shots;
  invaders = hitAfterMove.invaders;
  score += hitAfterMove.hits * 10;

  if (invaders.length === 0) {
    const nextLevel = state.level + 1;
    return {
      ...state,
      tick,
      score: score + 50,
      level: nextLevel,
      playerX: Math.floor(width / 2),
      invaders: createInvaders(width, nextLevel),
      shots: [],
      direction: 1
    };
  }

  const breach = invaders.some(invader => invader.y >= height - 2);
  if (breach) {
    if (state.lives <= 1) {
      return {
        ...state,
        tick,
        score,
        shots: [],
        invaders,
        lives: 0,
        phase: 'gameover'
      };
    }

    return {
      ...resetWave(state, width),
      tick,
      score,
      lives: state.lives - 1
    };
  }

  return {
    ...state,
    tick,
    score,
    shots,
    invaders,
    direction
  };
}

function createStarfield(width: number, height: number): Array<{ x: number; y: number }> {
  const stars: Array<{ x: number; y: number }> = [];

  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((x * 17 + y * 31) % 47 === 0) {
        stars.push({ x, y });
      }
    }
  }

  return stars;
}

function buildSegments(state: ArcadeState, width: number, height: number, stars: Array<{ x: number; y: number }>): RowSegment[][] {
  const cells: Array<Array<{ char: string; color: string }>> = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({
      char: ' ',
      color: palette.text
    }))
  );

  for (const star of stars) {
    if (star.y < height && star.x < width) {
      cells[star.y][star.x] = {
        char: '.',
        color: palette.dim
      };
    }
  }

  for (const invader of state.invaders) {
    if (invader.y >= 0 && invader.y < height && invader.x >= 0 && invader.x < width) {
      cells[invader.y][invader.x] = {
        char: 'M',
        color: palette.accent
      };
    }
  }

  for (const shot of state.shots) {
    if (shot.y >= 0 && shot.y < height && shot.x >= 0 && shot.x < width) {
      cells[shot.y][shot.x] = {
        char: '|',
        color: palette.cyan
      };
    }
  }

  const playerRow = height - 1;
  cells[playerRow][clamp(state.playerX, 0, width - 1)] = {
    char: 'A',
    color: palette.green
  };

  return cells.map(row => {
    const segments: RowSegment[] = [];
    let currentColor = row[0]?.color ?? palette.text;
    let currentText = '';

    for (const cell of row) {
      if (cell.color !== currentColor) {
        segments.push({ text: currentText, color: currentColor });
        currentColor = cell.color;
        currentText = cell.char;
      } else {
        currentText += cell.char;
      }
    }

    if (currentText) {
      segments.push({ text: currentText, color: currentColor });
    }

    return segments;
  });
}

function NeonInvadersGame({ width, height, onExit }: ArcadeGameProps) {
  const gridWidth = Math.max(24, Math.min(44, width - 6));
  const gridHeight = Math.max(12, Math.min(20, height - 8));
  const [state, setState] = useState<ArcadeState>(() => createArcadeState(gridWidth));

  useEffect(() => {
    setState(createArcadeState(gridWidth));
  }, [gridHeight, gridWidth]);

  useEffect(() => {
    const timer = setInterval(() => {
      setState(current => stepArcade(current, gridWidth, gridHeight));
    }, 110);

    return () => {
      clearInterval(timer);
    };
  }, [gridHeight, gridWidth]);

  useInput((input, key) => {
    if (input === 'g' || input === 'G' || key.escape) {
      onExit();
      return;
    }

    if (input === 'r' || input === 'R') {
      setState(createArcadeState(gridWidth));
      return;
    }

    if (state.phase !== 'playing') {
      if (key.return || input === ' ') {
        setState(createArcadeState(gridWidth));
      }
      return;
    }

    if (key.leftArrow || input === 'a' || input === 'A') {
      setState(current => ({
        ...current,
        playerX: Math.max(0, current.playerX - 1)
      }));
      return;
    }

    if (key.rightArrow || input === 'd' || input === 'D') {
      setState(current => ({
        ...current,
        playerX: Math.min(gridWidth - 1, current.playerX + 1)
      }));
      return;
    }

    if (input === ' ' || key.return) {
      setState(current => fireShot(current, gridHeight));
    }
  });

  const stars = useMemo(() => createStarfield(gridWidth, gridHeight), [gridHeight, gridWidth]);
  const segments = useMemo(() => buildSegments(state, gridWidth, gridHeight, stars), [gridHeight, gridWidth, stars, state]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text color={palette.text}>{`Score ${String(state.score).padStart(5, '0')}`}</Text>
        <Text color={palette.text}>{`Lives ${state.lives}`}</Text>
        <Text color={palette.text}>{`Level ${state.level}`}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {segments.map((row, rowIndex) => (
          <Box key={`arcade-row-${rowIndex}`} flexShrink={0}>
            {row.map((segment, segmentIndex) => (
              <Text key={`arcade-segment-${rowIndex}-${segmentIndex}`} color={segment.color}>
                {segment.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {state.phase === 'gameover' ? (
          <Text color={palette.danger}>The swarm broke through. Press `R` or Enter to restart.</Text>
        ) : (
          <Text color={palette.accent}>Hold the line and clear the wave before it reaches the bottom.</Text>
        )}
        <HintLine>Controls: left/right or A/D move, Space fires, Esc returns to the arcade menu.</HintLine>
      </Box>
    </Box>
  );
}

const game: ArcadeGameDefinition = {
  id: 'neon-invaders',
  title: "Neon Invaders",
  year: '1984',
  tagline: 'Defend the terminal from a pixel swarm.',
  description: 'A fast ASCII riff on the arcade classic. Clear each wave before the invaders reach the bottom row.',
  marquee: ['NEON INVADERS', 'DEFEND THE CODEBASE'],
  controls: ['Move: left/right or A/D', 'Fire: Space or Enter', 'Back to menu: Esc'],
  component: NeonInvadersGame
};

export default game;
