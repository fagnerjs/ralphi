import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { ArcadeGameDefinition, ArcadeGameProps } from '../types.js';
import { HintLine } from '../../ui/components.js';
import { palette } from '../../ui/theme.js';
import {
  brickBlitzPaddleWidth,
  createBrickBlitzState,
  launchBall,
  movePaddle,
  stepBrickBlitz,
  type BrickBlitzState
} from './engine.js';

interface RowSegment {
  text: string;
  color: string;
}

function brickColor(y: number): string {
  if (y === 1) {
    return palette.yellow;
  }
  if (y === 2) {
    return palette.accent;
  }
  if (y === 3) {
    return palette.cyan;
  }
  return palette.green;
}

function buildSegments(state: BrickBlitzState, width: number, height: number): RowSegment[][] {
  const cells: Array<Array<{ char: string; color: string }>> = Array.from({ length: height }, (_, rowIndex) =>
    Array.from({ length: width }, (_, columnIndex) => ({
      char: columnIndex === 0 || columnIndex === width - 1 ? '║' : rowIndex === 0 ? '═' : ' ',
      color: palette.borderSoft
    }))
  );

  for (const brick of state.bricks) {
    const [xText, yText] = brick.split(':');
    const x = Number(xText);
    const y = Number(yText);
    if (Number.isFinite(x) && Number.isFinite(y) && y >= 0 && y < height && x >= 0 && x < width) {
      cells[y][x] = {
        char: '▓',
        color: brickColor(y)
      };
    }
  }

  for (let offset = 0; offset < brickBlitzPaddleWidth; offset += 1) {
    const x = state.paddleX + offset;
    if (x >= 0 && x < width) {
      cells[height - 1][x] = {
        char: '█',
        color: palette.green
      };
    }
  }

  if (state.ballY >= 0 && state.ballY < height && state.ballX >= 0 && state.ballX < width) {
    cells[state.ballY][state.ballX] = {
      char: '●',
      color: palette.text
    };
  }

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

function BrickBlitzGame({ width, height, highScore, reportScore, onExit }: ArcadeGameProps) {
  const boardWidth = Math.max(28, width - 2);
  const boardHeight = Math.max(12, height - 6);
  const [state, setState] = useState(() => createBrickBlitzState(boardWidth, boardHeight));

  useEffect(() => {
    setState(createBrickBlitzState(boardWidth, boardHeight));
  }, [boardHeight, boardWidth]);

  useEffect(() => {
    const timer = setInterval(() => {
      setState(current => stepBrickBlitz(current, boardWidth, boardHeight));
    }, 75);

    return () => {
      clearInterval(timer);
    };
  }, [boardHeight, boardWidth]);

  useEffect(() => {
    reportScore(state.score);
  }, [reportScore, state.score]);

  useInput((input, key) => {
    if (input === 'g' || input === 'G' || key.escape) {
      onExit();
      return;
    }

    if (input === 'r' || input === 'R') {
      setState(createBrickBlitzState(boardWidth, boardHeight));
      return;
    }

    if (state.phase === 'serve') {
      if (key.return || input === ' ') {
        setState(current => launchBall(current));
      }
      return;
    }

    if (state.phase === 'gameover' || state.phase === 'cleared') {
      if (key.return || input === ' ') {
        setState(createBrickBlitzState(boardWidth, boardHeight));
      }
      return;
    }

    if (key.leftArrow || input === 'a' || input === 'A') {
      setState(current => movePaddle(current, -1, boardWidth));
      return;
    }

    if (key.rightArrow || input === 'd' || input === 'D') {
      setState(current => movePaddle(current, 1, boardWidth));
    }
  });

  const segments = useMemo(() => buildSegments(state, boardWidth, boardHeight), [boardHeight, boardWidth, state]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text color={palette.yellow}>{`Score ${String(state.score).padStart(4, '0')}`}</Text>
        <Text color={palette.cyan}>{`HI ${String(highScore).padStart(5, '0')}`}</Text>
        <Text color={palette.green}>{`Lives ${state.lives}`}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {segments.map((row, rowIndex) => (
          <Box key={`brick-blitz-row-${rowIndex}`} flexShrink={0}>
            {row.map((segment, segmentIndex) => (
              <Text key={`brick-blitz-segment-${rowIndex}-${segmentIndex}`} color={segment.color}>
                {segment.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {state.phase === 'gameover' ? (
          <Text color={palette.danger}>The last ball slipped out. Press Enter or R to reload the cabinet.</Text>
        ) : state.phase === 'cleared' ? (
          <Text color={palette.green}>Stage clear. Press Enter for another wall of neon bricks.</Text>
        ) : state.phase === 'serve' ? (
          <Text color={palette.accent}>Angle the rebound, protect the paddle, and press Enter or Space to launch.</Text>
        ) : (
          <Text color={palette.cyan}>Crack the brick wall and keep the ball alive as the cabinet speeds up.</Text>
        )}
        <HintLine>Controls: left/right or A/D move, Enter or Space launches, Esc returns to the menu.</HintLine>
      </Box>
    </Box>
  );
}

const game: ArcadeGameDefinition = {
  id: 'brick-blitz',
  title: 'Brick Blitz',
  year: '1986',
  tagline: 'Smash a neon wall one ricochet at a time.',
  description: 'A retro brick breaker with glowing lanes, fast rebounds, and one job: keep the ball in play until every brick is gone.',
  marquee: ['BRICK BLITZ', 'RICOCHET // CLEAR // SURVIVE'],
  controls: ['Move: left/right or A/D', 'Launch: Enter or Space', 'Restart: R', 'Back to menu: Esc'],
  component: BrickBlitzGame
};

export default game;
