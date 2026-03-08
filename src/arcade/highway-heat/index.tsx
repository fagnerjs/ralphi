import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { ArcadeGameDefinition, ArcadeGameProps } from '../types.js';
import { HintLine } from '../../ui/components.js';
import { palette } from '../../ui/theme.js';
import {
  createHighwayHeatState,
  highwayHeatLaneCount,
  moveDriver,
  stepHighwayHeat,
  type HighwayHeatState
} from './engine.js';

interface RowSegment {
  text: string;
  color: string;
}

function laneCell(occupied: boolean, laneIndex: number, isPlayer = false): { text: string; color: string } {
  if (isPlayer) {
    return {
      text: laneIndex === 2 ? '▲▲▲' : '███',
      color: palette.green
    };
  }

  if (occupied) {
    return {
      text: laneIndex % 2 === 0 ? '▓▓▓' : '▒▒▒',
      color: laneIndex % 2 === 0 ? palette.accent : palette.yellow
    };
  }

  return {
    text: laneIndex === 2 ? ' · ' : '   ',
    color: palette.dim
  };
}

function buildRoadSegments(state: HighwayHeatState): RowSegment[][] {
  const rows: RowSegment[][] = state.rows.map(row => {
    const segments: RowSegment[] = [{ text: '║', color: palette.borderSoft }];

    for (let lane = 0; lane < highwayHeatLaneCount; lane += 1) {
      const cell = laneCell(row.includes(lane), lane);
      segments.push(cell);
      segments.push({ text: lane === highwayHeatLaneCount - 1 ? '║' : '│', color: palette.borderSoft });
    }

    return segments;
  });

  const playerRow: RowSegment[] = [{ text: '║', color: palette.borderSoft }];
  for (let lane = 0; lane < highwayHeatLaneCount; lane += 1) {
    const cell = laneCell(false, lane, lane === state.playerLane);
    playerRow.push(cell);
    playerRow.push({ text: lane === highwayHeatLaneCount - 1 ? '║' : '│', color: palette.borderSoft });
  }
  rows.push(playerRow);

  return rows;
}

function HighwayHeatGame({ height, highScore, reportScore, onExit }: ArcadeGameProps) {
  const roadHeight = Math.max(8, height - 7);
  const [state, setState] = useState(() => createHighwayHeatState(roadHeight));

  useEffect(() => {
    setState(createHighwayHeatState(roadHeight));
  }, [roadHeight]);

  useEffect(() => {
    const intervalMs = Math.max(70, 150 - (state.level - 1) * 8);
    const timer = setInterval(() => {
      setState(current => stepHighwayHeat(current, roadHeight));
    }, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [roadHeight, state.level]);

  useEffect(() => {
    reportScore(state.score);
  }, [reportScore, state.score]);

  useInput((input, key) => {
    if (input === 'g' || input === 'G' || key.escape) {
      onExit();
      return;
    }

    if (input === 'r' || input === 'R') {
      setState(createHighwayHeatState(roadHeight));
      return;
    }

    if (state.phase === 'gameover') {
      if (key.return || input === ' ') {
        setState(createHighwayHeatState(roadHeight));
      }
      return;
    }

    if (key.leftArrow || input === 'a' || input === 'A') {
      setState(current => moveDriver(current, -1));
      return;
    }

    if (key.rightArrow || input === 'd' || input === 'D') {
      setState(current => moveDriver(current, 1));
    }
  });

  const road = useMemo(() => buildRoadSegments(state), [state]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text color={palette.green}>{`Score ${String(state.score).padStart(5, '0')}`}</Text>
        <Text color={palette.yellow}>{`Hi ${String(highScore).padStart(5, '0')}`}</Text>
        <Text color={palette.accent}>{`Level ${state.level}`}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {road.map((row, rowIndex) => (
          <Box key={`highway-heat-row-${rowIndex}`} flexShrink={0}>
            {row.map((segment, segmentIndex) => (
              <Text key={`highway-heat-segment-${rowIndex}-${segmentIndex}`} color={segment.color}>
                {segment.text}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {state.phase === 'gameover' ? (
          <Text color={palette.danger}>Traffic closed the lane. Press Enter or R to roll another night run.</Text>
        ) : (
          <Text color={palette.cyan}>Slip through the traffic, survive the faster waves, and keep the neon road glowing.</Text>
        )}
        <HintLine>Controls: left/right or A/D steer, R restarts, Esc returns to the menu.</HintLine>
      </Box>
    </Box>
  );
}

const game: ArcadeGameDefinition = {
  id: 'highway-heat',
  title: 'Highway Heat',
  year: '1985',
  tagline: 'Dodge midnight traffic on a glowing five-lane road.',
  description: 'A synthwave road challenge built for quick reflexes. Slide lane to lane, avoid oncoming traffic, and chase a bigger score.',
  marquee: ['HIGHWAY HEAT', 'DODGE // SURVIVE // SCORE'],
  controls: ['Steer: left/right or A/D', 'Restart: R', 'Back to menu: Esc'],
  component: HighwayHeatGame
};

export default game;
