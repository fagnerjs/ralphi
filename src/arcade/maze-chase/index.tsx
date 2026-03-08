import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { ArcadeGameDefinition, ArcadeGameProps } from '../types.js';
import { HintLine } from '../../ui/components.js';
import { palette } from '../../ui/theme.js';

type MazePhase = 'playing' | 'gameover';
type Direction = 'up' | 'down' | 'left' | 'right';

interface Position {
  x: number;
  y: number;
}

interface MazeState {
  phase: MazePhase;
  player: Position;
  ghost: Position;
  dots: Set<string>;
  score: number;
  level: number;
  lives: number;
}

const mazeLayout = [
  '####################',
  '#........##........#',
  '#.####.#.##.#.####.#',
  '#.#  #.#....#.#  #.#',
  '#.#  #.######.#  #.#',
  '#........##........#',
  '####.#.######.#.####',
  '#....#....##..#....#',
  '#.######. ## .######',
  '#........##........#',
  '####################'
];

const playerStart: Position = { x: 1, y: 1 };
const ghostStart: Position = { x: 18, y: 9 };
const directionVectors: Record<Direction, Position> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};

function encode(position: Position): string {
  return `${position.x}:${position.y}`;
}

function isWall(position: Position): boolean {
  return mazeLayout[position.y]?.[position.x] === '#';
}

function buildDots(): Set<string> {
  const dots = new Set<string>();
  for (let y = 0; y < mazeLayout.length; y += 1) {
    for (let x = 0; x < mazeLayout[y].length; x += 1) {
      if (mazeLayout[y][x] === '.') {
        dots.add(encode({ x, y }));
      }
    }
  }
  return dots;
}

function createState(level = 1, score = 0, lives = 3): MazeState {
  const dots = buildDots();
  dots.delete(encode(playerStart));

  return {
    phase: 'playing',
    player: { ...playerStart },
    ghost: { ...ghostStart },
    dots,
    score,
    level,
    lives
  };
}

function movePosition(position: Position, direction: Direction): Position {
  const vector = directionVectors[direction];
  return {
    x: position.x + vector.x,
    y: position.y + vector.y
  };
}

function validMoves(position: Position): Direction[] {
  return (Object.keys(directionVectors) as Direction[]).filter(direction => {
    const next = movePosition(position, direction);
    return !isWall(next);
  });
}

function applyPlayerMove(state: MazeState, direction: Direction): MazeState {
  if (state.phase !== 'playing') {
    return state;
  }

  const nextPlayer = movePosition(state.player, direction);
  if (isWall(nextPlayer)) {
    return state;
  }

  const nextDots = new Set(state.dots);
  let score = state.score;
  if (nextDots.delete(encode(nextPlayer))) {
    score += 10;
  }

  if (nextPlayer.x === state.ghost.x && nextPlayer.y === state.ghost.y) {
    if (state.lives <= 1) {
      return {
        ...state,
        player: nextPlayer,
        dots: nextDots,
        score,
        lives: 0,
        phase: 'gameover'
      };
    }

    return createState(state.level, score, state.lives - 1);
  }

  if (nextDots.size === 0) {
    return createState(state.level + 1, score + 100, state.lives);
  }

  return {
    ...state,
    player: nextPlayer,
    dots: nextDots,
    score
  };
}

function pickGhostMove(state: MazeState): Direction {
  const options = validMoves(state.ghost);
  if (options.length === 0) {
    return 'left';
  }

  return options.reduce((best, direction) => {
    const candidate = movePosition(state.ghost, direction);
    const bestPosition = movePosition(state.ghost, best);
    const candidateDistance = Math.abs(candidate.x - state.player.x) + Math.abs(candidate.y - state.player.y);
    const bestDistance = Math.abs(bestPosition.x - state.player.x) + Math.abs(bestPosition.y - state.player.y);
    return candidateDistance < bestDistance ? direction : best;
  }, options[0]);
}

function tickState(state: MazeState): MazeState {
  if (state.phase !== 'playing') {
    return state;
  }

  const nextGhost = movePosition(state.ghost, pickGhostMove(state));
  if (nextGhost.x === state.player.x && nextGhost.y === state.player.y) {
    if (state.lives <= 1) {
      return {
        ...state,
        ghost: nextGhost,
        lives: 0,
        phase: 'gameover'
      };
    }

    return createState(state.level, state.score, state.lives - 1);
  }

  return {
    ...state,
    ghost: nextGhost
  };
}

function MazeChaseGame({ onExit }: ArcadeGameProps) {
  const [state, setState] = useState<MazeState>(() => createState());

  useEffect(() => {
    setState(createState());
  }, []);

  useEffect(() => {
    const intervalMs = Math.max(120, 260 - (state.level - 1) * 12);
    const timer = setInterval(() => {
      setState(current => tickState(current));
    }, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [state.level]);

  useInput((input, key) => {
    if (input === 'g' || input === 'G' || key.escape) {
      onExit();
      return;
    }

    if (input === 'r' || input === 'R') {
      setState(createState());
      return;
    }

    if (state.phase !== 'playing') {
      if (input === ' ' || key.return) {
        setState(createState());
      }
      return;
    }

    if (key.upArrow || input === 'w' || input === 'W') {
      setState(current => applyPlayerMove(current, 'up'));
      return;
    }

    if (key.downArrow || input === 's' || input === 'S') {
      setState(current => applyPlayerMove(current, 'down'));
      return;
    }

    if (key.leftArrow || input === 'a' || input === 'A') {
      setState(current => applyPlayerMove(current, 'left'));
      return;
    }

    if (key.rightArrow || input === 'd' || input === 'D') {
      setState(current => applyPlayerMove(current, 'right'));
    }
  });

  const mazeLines = useMemo(
    () =>
      mazeLayout.map((row, rowIndex) =>
        row
          .split('')
          .map((cell, columnIndex) => {
            const positionKey = encode({ x: columnIndex, y: rowIndex });
            if (state.player.x === columnIndex && state.player.y === rowIndex) {
              return { text: 'C', color: palette.yellow };
            }
            if (state.ghost.x === columnIndex && state.ghost.y === rowIndex) {
              return { text: 'G', color: palette.danger };
            }
            if (cell === '#') {
              return { text: '#', color: palette.accentSoft };
            }
            if (state.dots.has(positionKey)) {
              return { text: '.', color: palette.green };
            }
            return { text: ' ', color: palette.text };
          })
          .reduce<Array<{ text: string; color: string }>>((segments, entry) => {
            const previous = segments[segments.length - 1];
            if (previous && previous.color === entry.color) {
              previous.text += entry.text;
              return segments;
            }

            return [...segments, { ...entry }];
          }, [])
      ),
    [state.dots, state.ghost.x, state.ghost.y, state.player.x, state.player.y]
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text color={palette.text}>{`Score ${String(state.score).padStart(5, '0')}`}</Text>
        <Text color={palette.text}>{`Dots ${String(state.dots.size).padStart(3, '0')}`}</Text>
        <Text color={palette.text}>{`Lives ${state.lives}`}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {mazeLines.map((segments, rowIndex) => (
          <Box key={`maze-row-${rowIndex}`}>
            {segments.map((segment, segmentIndex) => (
              <Text key={`maze-segment-${rowIndex}-${segmentIndex}`} color={segment.color}>
                {segment.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {state.phase === 'gameover' ? (
          <Text color={palette.danger}>The ghost caught you. Press `R` or Enter to restart the maze.</Text>
        ) : (
          <Text color={palette.accent}>Sweep every dot, dodge the ghost, and hold the lane.</Text>
        )}
        <HintLine>Controls: arrows or WASD move, Esc returns to the arcade menu.</HintLine>
      </Box>
    </Box>
  );
}

const game: ArcadeGameDefinition = {
  id: 'maze-chase',
  title: 'Maze Chase',
  year: '1982',
  tagline: 'Collect the dots before the ghost corners you.',
  description: 'A dot-chasing maze with one aggressive ghost and a tighter board. Clear the maze, gain a level, and survive the faster pursuit.',
  marquee: ['MAZE CHASE', 'CLEAR THE DOTS // DODGE THE GHOST'],
  controls: ['Move: arrows or WASD', 'Restart: R or Enter after a loss', 'Back to menu: Esc'],
  component: MazeChaseGame
};

export default game;
