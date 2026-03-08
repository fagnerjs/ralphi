import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { ArcadeGameDefinition, ArcadeGameProps } from '../types.js';
import { HintLine } from '../../ui/components.js';
import { palette } from '../../ui/theme.js';
import {
  createVectorPongState,
  launchServe,
  movePlayerPaddle,
  stepVectorPong,
  vectorPongPaddleSize,
  type VectorPongState
} from './engine.js';

interface RowSegment {
  text: string;
  color: string;
}

function buildSegments(state: VectorPongState, width: number, height: number): RowSegment[][] {
  const cells: Array<Array<{ char: string; color: string }>> = Array.from({ length: height }, (_, rowIndex) =>
    Array.from({ length: width }, (_, columnIndex) => ({
      char: columnIndex === Math.floor(width / 2) && rowIndex % 2 === 0 ? '┊' : ' ',
      color: palette.borderSoft
    }))
  );

  for (let offset = 0; offset < vectorPongPaddleSize; offset += 1) {
    const playerRow = state.playerY + offset;
    const cpuRow = state.cpuY + offset;
    if (playerRow >= 0 && playerRow < height) {
      cells[playerRow][1] = {
        char: '█',
        color: palette.green
      };
    }
    if (cpuRow >= 0 && cpuRow < height) {
      cells[cpuRow][width - 2] = {
        char: '█',
        color: palette.accent
      };
    }
  }

  if (state.ballY >= 0 && state.ballY < height && state.ballX >= 0 && state.ballX < width) {
    cells[state.ballY][state.ballX] = {
      char: '●',
      color: palette.yellow
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

function VectorPongGame({ width, height, highScore, reportScore, onExit }: ArcadeGameProps) {
  const courtWidth = Math.max(34, width - 2);
  const courtHeight = Math.max(12, height - 6);
  const [state, setState] = useState(() => createVectorPongState(courtWidth, courtHeight));

  useEffect(() => {
    setState(createVectorPongState(courtWidth, courtHeight));
  }, [courtHeight, courtWidth]);

  useEffect(() => {
    const timer = setInterval(() => {
      setState(current => stepVectorPong(current, courtWidth, courtHeight));
    }, 70);

    return () => {
      clearInterval(timer);
    };
  }, [courtHeight, courtWidth]);

  useEffect(() => {
    reportScore(state.score.player);
  }, [reportScore, state.score.player]);

  useInput((input, key) => {
    if (input === 'g' || input === 'G' || key.escape) {
      onExit();
      return;
    }

    if (input === 'r' || input === 'R') {
      setState(createVectorPongState(courtWidth, courtHeight));
      return;
    }

    if (state.phase === 'serve') {
      if (key.return || input === ' ') {
        setState(current => launchServe(current));
      }
      return;
    }

    if (state.phase === 'gameover') {
      if (key.return || input === ' ') {
        setState(launchServe(createVectorPongState(courtWidth, courtHeight)));
      }
      return;
    }

    if (key.upArrow || input === 'w' || input === 'W') {
      setState(current => movePlayerPaddle(current, -1, courtHeight));
      return;
    }

    if (key.downArrow || input === 's' || input === 'S') {
      setState(current => movePlayerPaddle(current, 1, courtHeight));
    }
  });

  const segments = useMemo(() => buildSegments(state, courtWidth, courtHeight), [courtHeight, courtWidth, state]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text color={palette.green}>{`PLAYER ${String(state.score.player).padStart(2, '0')}`}</Text>
        <Text color={palette.yellow}>{`HI ${String(highScore).padStart(5, '0')}`}</Text>
        <Text color={palette.accent}>{`CPU ${String(state.score.cpu).padStart(2, '0')}`}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {segments.map((row, rowIndex) => (
          <Box key={`vector-pong-row-${rowIndex}`} flexShrink={0}>
            {row.map((segment, segmentIndex) => (
              <Text key={`vector-pong-segment-${rowIndex}-${segmentIndex}`} color={segment.color}>
                {segment.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {state.phase === 'gameover' ? (
          <Text color={palette.yellow}>{`${state.winner === 'player' ? 'Player' : 'CPU'} wins the cabinet. Press Enter or R for a rematch.`}</Text>
        ) : state.phase === 'serve' ? (
          <Text color={palette.accent}>Hold the line and angle your returns. Press Enter or Space to serve.</Text>
        ) : (
          <Text color={palette.cyan}>Use the paddle edge to change the ball angle and race to seven points.</Text>
        )}
        <HintLine>Controls: up/down or W/S move, Enter or Space serves, Esc returns to the menu.</HintLine>
      </Box>
    </Box>
  );
}

const game: ArcadeGameDefinition = {
  id: 'vector-pong',
  title: 'Vector Pong',
  year: '1982',
  tagline: 'Volley glowing vectors across a phosphor court.',
  description: 'A neon duel of reflexes and ricochets. Beat the cabinet CPU to seven points and own the scoreboard glow.',
  marquee: ['VECTOR PONG', 'SERVE // SLICE // SCORE'],
  controls: ['Move: up/down or W/S', 'Serve: Enter or Space', 'Restart: R', 'Back to menu: Esc'],
  component: VectorPongGame
};

export default game;
