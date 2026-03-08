import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { ArcadeGameDefinition, ArcadeGameProps } from '../types.js';
import { HintLine } from '../../ui/components.js';
import { palette } from '../../ui/theme.js';
import {
  createCircuitDuelState,
  setPlayerDirection,
  startNextRound,
  stepCircuitDuel,
  type CircuitDuelState
} from './engine.js';

interface RowSegment {
  text: string;
  color: string;
}

function buildSegments(state: CircuitDuelState, width: number, height: number): RowSegment[][] {
  const cells: Array<Array<{ char: string; color: string }>> = Array.from({ length: height }, (_, rowIndex) =>
    Array.from({ length: width }, (_, columnIndex) => ({
      char: (columnIndex + rowIndex * 3) % 19 === 0 ? '.' : ' ',
      color: palette.dim
    }))
  );

  for (const cell of state.trail) {
    if (cell.x >= 0 && cell.x < width && cell.y >= 0 && cell.y < height) {
      cells[cell.y][cell.x] = {
        char: cell.owner === 'player' ? '=' : '-',
        color: cell.owner === 'player' ? palette.green : palette.accent
      };
    }
  }

  if (state.player.head.x >= 0 && state.player.head.x < width && state.player.head.y >= 0 && state.player.head.y < height) {
    cells[state.player.head.y][state.player.head.x] = {
      char: 'P',
      color: palette.green
    };
  }

  if (state.rival.head.x >= 0 && state.rival.head.x < width && state.rival.head.y >= 0 && state.rival.head.y < height) {
    cells[state.rival.head.y][state.rival.head.x] = {
      char: 'R',
      color: palette.accent
    };
  }

  return cells.map(row => {
    const segments: RowSegment[] = [];
    let currentColor = row[0]?.color ?? palette.dim;
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

function statusMessage(state: CircuitDuelState): { text: string; color: string } {
  if (state.phase === 'gameover') {
    return {
      text: `${state.outcome === 'player' ? 'You' : 'The rival'} own the grid. Press R or Enter to start a new match.`,
      color: state.outcome === 'player' ? palette.green : palette.danger
    };
  }

  if (state.phase === 'round-over') {
    if (state.outcome === 'draw') {
      return {
        text: 'Both bikes folded on impact. Press Enter for the next round.',
        color: palette.yellow
      };
    }

    return {
      text: `${state.outcome === 'player' ? 'You' : 'The rival'} took the round. Press Enter to launch the next duel.`,
      color: state.outcome === 'player' ? palette.green : palette.danger
    };
  }

  return {
    text: 'Cut the lane, box the rival in, and never leave yourself without a runway.',
    color: palette.accent
  };
}

function CircuitDuelGame({ width, height, onExit }: ArcadeGameProps) {
  const gridWidth = Math.max(30, width - 2);
  const gridHeight = Math.max(12, height - 6);
  const [state, setState] = useState(() => createCircuitDuelState(gridWidth, gridHeight));

  useEffect(() => {
    setState(createCircuitDuelState(gridWidth, gridHeight));
  }, [gridHeight, gridWidth]);

  useEffect(() => {
    const intervalMs = Math.max(38, 92 - (state.round - 1) * 4);
    const timer = setInterval(() => {
      setState(current => stepCircuitDuel(current, gridWidth, gridHeight));
    }, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [gridHeight, gridWidth, state.round]);

  useInput((input, key) => {
    if (input === 'g' || input === 'G' || key.escape) {
      onExit();
      return;
    }

    if (input === 'r' || input === 'R') {
      setState(createCircuitDuelState(gridWidth, gridHeight));
      return;
    }

    if (state.phase !== 'playing') {
      if (key.return || input === ' ') {
        setState(current =>
          current.phase === 'gameover' ? createCircuitDuelState(gridWidth, gridHeight) : startNextRound(current, gridWidth, gridHeight)
        );
      }
      return;
    }

    if (key.upArrow || input === 'w' || input === 'W') {
      setState(current => setPlayerDirection(current, 'up'));
      return;
    }

    if (key.downArrow || input === 's' || input === 'S') {
      setState(current => setPlayerDirection(current, 'down'));
      return;
    }

    if (key.leftArrow || input === 'a' || input === 'A') {
      setState(current => setPlayerDirection(current, 'left'));
      return;
    }

    if (key.rightArrow || input === 'd' || input === 'D') {
      setState(current => setPlayerDirection(current, 'right'));
    }
  });

  const segments = useMemo(() => buildSegments(state, gridWidth, gridHeight), [gridHeight, gridWidth, state]);
  const message = statusMessage(state);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text color={palette.text}>{`You ${state.score.player}`}</Text>
        <Text color={palette.text}>{`Round ${String(state.round).padStart(2, '0')}`}</Text>
        <Text color={palette.text}>{`Rival ${state.score.rival}`}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {segments.map((row, rowIndex) => (
          <Box key={`circuit-row-${rowIndex}`} flexShrink={0}>
            {row.map((segment, segmentIndex) => (
              <Text key={`circuit-segment-${rowIndex}-${segmentIndex}`} color={segment.color}>
                {segment.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={message.color}>{message.text}</Text>
        <HintLine>Controls: arrows or WASD steer, Enter advances after a round, Esc returns to the arcade menu.</HintLine>
      </Box>
    </Box>
  );
}

const game: ArcadeGameDefinition = {
  id: 'circuit-duel',
  title: 'Circuit Duel',
  year: '1982',
  tagline: 'A full-width light-cycle chase across the terminal grid.',
  description:
    'A neon lane duel built for wide terminals. Leave a burning trail, trap the rival bike, and win the match before the grid closes in.',
  marquee: ['CIRCUIT DUEL', 'TRAP THE RIVAL // OWN THE GRID'],
  controls: ['Steer: arrows or WASD', 'Next round: Enter or Space', 'Back to menu: Esc'],
  component: CircuitDuelGame
};

export default game;
