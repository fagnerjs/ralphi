import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { ArcadeGameDefinition, ArcadeGameProps } from '../types.js';
import { HintLine } from '../../ui/components.js';
import { palette } from '../../ui/theme.js';
import { createAsteroidRunState, fireLaser, moveShip, stepAsteroidRun, type AsteroidRunState } from './engine.js';

interface RowSegment {
  text: string;
  color: string;
}

function createStarfield(width: number, height: number): Array<{ x: number; y: number }> {
  const stars: Array<{ x: number; y: number }> = [];

  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((x * 13 + y * 17) % 61 === 0) {
        stars.push({ x, y });
      }
    }
  }

  return stars;
}

function buildSegments(
  state: AsteroidRunState,
  width: number,
  height: number,
  stars: Array<{ x: number; y: number }>
): RowSegment[][] {
  const cells: Array<Array<{ char: string; color: string }>> = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({
      char: ' ',
      color: palette.text
    }))
  );

  for (const star of stars) {
    if (star.y >= 0 && star.y < height && star.x >= 0 && star.x < width) {
      cells[star.y][star.x] = {
        char: '.',
        color: palette.dim
      };
    }
  }

  for (const rock of state.rocks) {
    if (rock.y >= 0 && rock.y < height && rock.x >= 0 && rock.x < width) {
      cells[rock.y][rock.x] = {
        char: rock.glyph,
        color: rock.glyph === 'O' ? palette.yellow : palette.accent
      };
    }
  }

  for (const laser of state.lasers) {
    if (laser.y >= 0 && laser.y < height && laser.x >= 0 && laser.x < width) {
      cells[laser.y][laser.x] = {
        char: '|',
        color: palette.cyan
      };
    }
  }

  const shipRow = height - 1;
  if (shipRow >= 0) {
    cells[shipRow][state.shipX] = {
      char: 'A',
      color: palette.green
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

function AsteroidRunGame({ width, height, onExit }: ArcadeGameProps) {
  const gridWidth = Math.max(36, width - 2);
  const gridHeight = Math.max(12, height - 6);
  const [state, setState] = useState(() => createAsteroidRunState(gridWidth));

  useEffect(() => {
    setState(createAsteroidRunState(gridWidth));
  }, [gridWidth, gridHeight]);

  useEffect(() => {
    const intervalMs = Math.max(45, 105 - (state.level - 1) * 8);
    const timer = setInterval(() => {
      setState(current => stepAsteroidRun(current, gridWidth, gridHeight));
    }, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [gridHeight, gridWidth, state.level]);

  useInput((input, key) => {
    if (input === 'g' || input === 'G' || key.escape) {
      onExit();
      return;
    }

    if (input === 'r' || input === 'R') {
      setState(createAsteroidRunState(gridWidth));
      return;
    }

    if (state.phase !== 'playing') {
      if (key.return || input === ' ') {
        setState(createAsteroidRunState(gridWidth));
      }
      return;
    }

    if (key.leftArrow || input === 'a' || input === 'A') {
      setState(current => moveShip(current, gridWidth, -1));
      return;
    }

    if (key.rightArrow || input === 'd' || input === 'D') {
      setState(current => moveShip(current, gridWidth, 1));
      return;
    }

    if (input === ' ' || key.return) {
      setState(current => fireLaser(current, gridHeight));
    }
  });

  const stars = useMemo(() => createStarfield(gridWidth, gridHeight), [gridHeight, gridWidth]);
  const segments = useMemo(() => buildSegments(state, gridWidth, gridHeight, stars), [gridHeight, gridWidth, stars, state]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text color={palette.text}>{`Score ${String(state.score).padStart(5, '0')}`}</Text>
        <Text color={palette.text}>{`Hull ${state.lives}`}</Text>
        <Text color={palette.text}>{`Sector ${state.level}`}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {segments.map((row, rowIndex) => (
          <Box key={`asteroid-row-${rowIndex}`} flexShrink={0}>
            {row.map((segment, segmentIndex) => (
              <Text key={`asteroid-segment-${rowIndex}-${segmentIndex}`} color={segment.color}>
                {segment.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {state.phase === 'gameover' ? (
          <Text color={palette.danger}>The belt overran your hull. Press `R` or Enter to relaunch.</Text>
        ) : (
          <Text color={palette.accent}>Burn through the debris field before the next wave reaches your lane.</Text>
        )}
        <HintLine>Controls: left/right or A/D move, Space fires, Esc returns to the arcade menu.</HintLine>
      </Box>
    </Box>
  );
}

const game: ArcadeGameDefinition = {
  id: 'asteroid-run',
  title: 'Asteroid Run',
  year: '1979',
  tagline: 'Thread the whole terminal through a hostile debris field.',
  description:
    'A wide-screen ASCII asteroid belt. Hold the lane, blast incoming rocks, and survive longer as the sector gets denser.',
  marquee: ['ASTEROID RUN', 'FULL WIDTH // FULL PANIC'],
  controls: ['Move: left/right or A/D', 'Fire: Space or Enter', 'Back to menu: Esc'],
  component: AsteroidRunGame
};

export default game;
