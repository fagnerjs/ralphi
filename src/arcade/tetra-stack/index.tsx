import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

import type { ArcadeGameDefinition, ArcadeGameProps } from '../types.js';
import { HintLine } from '../../ui/components.js';
import { palette } from '../../ui/theme.js';

type PieceKind = 'I' | 'O' | 'T' | 'L' | 'J' | 'S' | 'Z';
type CellValue = PieceKind | null;

interface PieceShape {
  kind: PieceKind;
  cells: Array<{ x: number; y: number }>;
  color: string;
}

interface FallingPiece {
  kind: PieceKind;
  x: number;
  y: number;
  rotation: number;
}

interface TetraState {
  phase: 'playing' | 'gameover';
  board: CellValue[][];
  piece: FallingPiece;
  nextKind: PieceKind;
  score: number;
  lines: number;
  level: number;
  tick: number;
}

interface RowSegment {
  text: string;
  color: string;
}

const boardWidth = 10;
const boardHeight = 16;
const pieceOrder: PieceKind[] = ['I', 'O', 'T', 'L', 'J', 'S', 'Z'];
const shapeMap: Record<PieceKind, PieceShape> = {
  I: {
    kind: 'I',
    color: palette.cyan,
    cells: [
      { x: -1, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 }
    ]
  },
  O: {
    kind: 'O',
    color: palette.yellow,
    cells: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 }
    ]
  },
  T: {
    kind: 'T',
    color: palette.accent,
    cells: [
      { x: -1, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 }
    ]
  },
  L: {
    kind: 'L',
    color: palette.accentSoft,
    cells: [
      { x: -1, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: -1, y: 1 }
    ]
  },
  J: {
    kind: 'J',
    color: palette.green,
    cells: [
      { x: -1, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 }
    ]
  },
  S: {
    kind: 'S',
    color: palette.green,
    cells: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: -1, y: 1 },
      { x: 0, y: 1 }
    ]
  },
  Z: {
    kind: 'Z',
    color: palette.danger,
    cells: [
      { x: -1, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 }
    ]
  }
};

function emptyBoard(): CellValue[][] {
  return Array.from({ length: boardHeight }, () => Array.from({ length: boardWidth }, () => null));
}

function rotateCell(cell: { x: number; y: number }, rotation: number): { x: number; y: number } {
  if (rotation === 0) {
    return cell;
  }

  let next = { ...cell };
  for (let index = 0; index < rotation; index += 1) {
    next = { x: -next.y, y: next.x };
  }

  return next;
}

function pieceCells(piece: FallingPiece): Array<{ x: number; y: number }> {
  return shapeMap[piece.kind].cells.map(cell => {
    const rotated = rotateCell(cell, piece.rotation);
    return {
      x: piece.x + rotated.x,
      y: piece.y + rotated.y
    };
  });
}

function randomKind(seed: number): PieceKind {
  return pieceOrder[Math.abs(seed) % pieceOrder.length] ?? 'T';
}

function createPiece(kind: PieceKind): FallingPiece {
  return {
    kind,
    x: Math.floor(boardWidth / 2),
    y: 1,
    rotation: 0
  };
}

function canPlace(board: CellValue[][], piece: FallingPiece): boolean {
  return pieceCells(piece).every(cell => {
    if (cell.x < 0 || cell.x >= boardWidth || cell.y < 0 || cell.y >= boardHeight) {
      return false;
    }

    return board[cell.y][cell.x] === null;
  });
}

function createState(): TetraState {
  const first = randomKind(0);
  const second = randomKind(1);
  return {
    phase: 'playing',
    board: emptyBoard(),
    piece: createPiece(first),
    nextKind: second,
    score: 0,
    lines: 0,
    level: 1,
    tick: 0
  };
}

function movePiece(state: TetraState, patch: Partial<FallingPiece>): TetraState {
  if (state.phase !== 'playing') {
    return state;
  }

  const candidate: FallingPiece = {
    ...state.piece,
    ...patch
  };

  if (!canPlace(state.board, candidate)) {
    return state;
  }

  return {
    ...state,
    piece: candidate
  };
}

function clearLines(board: CellValue[][]): { board: CellValue[][]; lines: number } {
  const keptRows = board.filter(row => row.some(cell => cell === null));
  const cleared = board.length - keptRows.length;
  const padding = Array.from({ length: cleared }, () => Array.from({ length: boardWidth }, () => null));
  return {
    board: [...padding, ...keptRows],
    lines: cleared
  };
}

function lockPiece(state: TetraState): TetraState {
  const nextBoard = state.board.map(row => [...row]);
  for (const cell of pieceCells(state.piece)) {
    if (cell.y < 0 || cell.y >= boardHeight || cell.x < 0 || cell.x >= boardWidth) {
      return {
        ...state,
        phase: 'gameover'
      };
    }

    nextBoard[cell.y][cell.x] = state.piece.kind;
  }

  const cleared = clearLines(nextBoard);
  const nextLines = state.lines + cleared.lines;
  const nextLevel = 1 + Math.floor(nextLines / 8);
  const nextPiece = createPiece(state.nextKind);
  const queuedKind = randomKind(state.tick + state.lines + nextLines + 3);

  if (!canPlace(cleared.board, nextPiece)) {
    return {
      ...state,
      board: cleared.board,
      score: state.score + cleared.lines * cleared.lines * 100,
      lines: nextLines,
      level: nextLevel,
      phase: 'gameover'
    };
  }

  return {
    ...state,
    board: cleared.board,
    piece: nextPiece,
    nextKind: queuedKind,
    score: state.score + cleared.lines * cleared.lines * 100 + 10,
    lines: nextLines,
    level: nextLevel
  };
}

function tickState(state: TetraState): TetraState {
  if (state.phase !== 'playing') {
    return state;
  }

  const candidate = {
    ...state.piece,
    y: state.piece.y + 1
  };

  if (canPlace(state.board, candidate)) {
    return {
      ...state,
      piece: candidate,
      tick: state.tick + 1
    };
  }

  return {
    ...lockPiece({
      ...state,
      tick: state.tick + 1
    })
  };
}

function buildSegments(board: CellValue[][], piece: FallingPiece): RowSegment[][] {
  const activeCells = new Map(pieceCells(piece).map(cell => [`${cell.x}:${cell.y}`, piece.kind] as const));

  return board.map((row, rowIndex) => {
    const segments: RowSegment[] = [];
    let currentColor: string = palette.dim;
    let currentText = '';

    for (let column = 0; column < row.length; column += 1) {
      const active = activeCells.get(`${column}:${rowIndex}`);
      const value = active ?? row[column];
      const char = value ? '#' : '.';
      const color = value ? shapeMap[value].color : palette.dim;

      if (currentText && color !== currentColor) {
        segments.push({ text: currentText, color: currentColor });
        currentText = char;
        currentColor = color;
      } else {
        currentText += char;
        currentColor = color;
      }
    }

    if (currentText) {
      segments.push({ text: currentText, color: currentColor });
    }

    return segments;
  });
}

function TetraStackGame({ highScore, reportScore, onExit }: ArcadeGameProps) {
  const [state, setState] = useState<TetraState>(() => createState());

  useEffect(() => {
    setState(createState());
  }, []);

  useEffect(() => {
    const intervalMs = Math.max(120, 420 - (state.level - 1) * 24);
    const timer = setInterval(() => {
      setState(current => tickState(current));
    }, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [state.level]);

  useEffect(() => {
    reportScore(state.score);
  }, [reportScore, state.score]);

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

    if (key.leftArrow || input === 'a' || input === 'A') {
      setState(current => movePiece(current, { x: current.piece.x - 1 }));
      return;
    }

    if (key.rightArrow || input === 'd' || input === 'D') {
      setState(current => movePiece(current, { x: current.piece.x + 1 }));
      return;
    }

    if (key.downArrow || input === 's' || input === 'S') {
      setState(current => tickState(current));
      return;
    }

    if (key.upArrow || input === 'w' || input === 'W') {
      setState(current => movePiece(current, { rotation: (current.piece.rotation + 1) % 4 }));
      return;
    }

    if (input === ' ') {
      setState(current => {
        let next = current;
        while (next.phase === 'playing') {
          const candidate = {
            ...next.piece,
            y: next.piece.y + 1
          };
          if (!canPlace(next.board, candidate)) {
            break;
          }
          next = {
            ...next,
            piece: candidate
          };
        }
        return lockPiece(next);
      });
    }
  });

  const segments = useMemo(() => buildSegments(state.board, state.piece), [state.board, state.piece]);
  const nextShape = shapeMap[state.nextKind];

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text color={palette.text}>{`Score ${String(state.score).padStart(5, '0')}`}</Text>
        <Text color={palette.yellow}>{`Hi ${String(highScore).padStart(5, '0')}`}</Text>
        <Text color={palette.text}>{`Lines ${String(state.lines).padStart(3, '0')} · Level ${state.level}`}</Text>
      </Box>
      <Box marginTop={1}>
        <Box flexDirection="column">
          {segments.map((row, rowIndex) => (
            <Box key={`tetra-row-${rowIndex}`}>
              {row.map((segment, segmentIndex) => (
                <Text key={`tetra-segment-${rowIndex}-${segmentIndex}`} color={segment.color}>
                  {segment.text}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
        <Box marginLeft={4} flexDirection="column">
          <Text color={palette.accent}>Next</Text>
          {Array.from({ length: 4 }, (_, rowIndex) => (
            <Text key={`next-${rowIndex}`} color={nextShape.color}>
              {Array.from({ length: 4 }, (_, columnIndex) =>
                nextShape.cells.some(cell => cell.x + 1 === columnIndex && cell.y === rowIndex) ? '#' : ' '
              ).join('')}
            </Text>
          ))}
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {state.phase === 'gameover' ? (
          <Text color={palette.danger}>The stack locked up. Press `R` or Enter to start another round.</Text>
        ) : (
          <Text color={palette.accent}>Stack clean lines before the matrix reaches the ceiling.</Text>
        )}
        <HintLine>Controls: left/right move, up rotates, down soft drops, Space hard drops, Esc returns to the menu.</HintLine>
      </Box>
    </Box>
  );
}

const game: ArcadeGameDefinition = {
  id: 'tetra-stack',
  title: 'Tetra Stack',
  year: '1989',
  tagline: 'Rotate the falling matrix and keep the board clean.',
  description: 'A compact terminal spin on the brick-stacking classic. Clear lines, survive faster drops, and keep the stack below the ceiling.',
  marquee: ['TETRA STACK', 'ROTATE // DROP // SURVIVE'],
  controls: ['Move: left/right or A/D', 'Rotate: up or W', 'Drop: down or S, Space hard drop', 'Back to menu: Esc'],
  component: TetraStackGame
};

export default game;
