import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Gradient from 'ink-gradient';
import { Spinner } from '@inkjs/ui';

import { loadArcadeGames } from '../arcade/loader.js';
import type { ArcadeGameDefinition } from '../arcade/types.js';
import { HintLine, SectionPanel } from './components.js';
import { palette } from './theme.js';

interface ArcadeCabinetProps {
  maxWidth?: number;
  maxHeight?: number;
  onClose: () => void;
}

function marqueeLines(game: ArcadeGameDefinition | null, width: number): string[] {
  if (!game) {
    return ['NO GAMES FOUND'];
  }

  return game.marquee.map(line => line.slice(0, Math.max(12, width)));
}

function repeatPattern(pattern: string, width: number): string {
  if (pattern.length === 0 || width <= 0) {
    return '';
  }

  return pattern.repeat(Math.ceil(width / pattern.length)).slice(0, width);
}

function cabinetHighScore(game: ArcadeGameDefinition | null): string {
  if (!game) {
    return '000000';
  }

  const seed = `${game.id}:${game.title}:${game.year}`.split('').reduce((total, char, index) => total + char.charCodeAt(0) * (index + 7), 0);
  return String(10000 + (seed % 890000)).padStart(6, '0');
}

function CabinetChoice({ game, active }: { game: ArcadeGameDefinition; active: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1} flexShrink={1}>
      <Box flexShrink={1}>
        <Text color={active ? palette.yellow : palette.dim}>{active ? '▶ ' : '· '}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={active ? palette.text : palette.dim} wrap="truncate-end">
            {game.title.toUpperCase()}
          </Text>
        </Box>
        <Text color={active ? palette.accent : palette.dim}>{game.year}</Text>
      </Box>
      <Box marginLeft={2} flexShrink={1}>
        <Text color={active ? palette.cyan : palette.dim} wrap="truncate-end">
          {game.tagline}
        </Text>
      </Box>
    </Box>
  );
}

export function ArcadeCabinet({ maxWidth, maxHeight, onClose }: ArcadeCabinetProps) {
  const [games, setGames] = useState<ArcadeGameDefinition[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [blinkOn, setBlinkOn] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void loadArcadeGames()
      .then(loaded => {
        if (cancelled) {
          return;
        }

        setGames(loaded);
        setSelectedIndex(0);
      })
      .catch(error => {
        if (cancelled) {
          return;
        }

        setLoadError(error instanceof Error ? error.message : 'Unable to load arcade games.');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setBlinkOn(current => !current);
    }, 650);

    return () => {
      clearInterval(timer);
    };
  }, []);

  const cabinetWidth = Math.max(40, maxWidth ?? 110);
  const cabinetHeight = Math.max(24, maxHeight ?? 36);
  const activeGame = games.find(game => game.id === activeGameId) ?? null;
  const ActiveGameComponent = activeGame?.component ?? null;
  const selectedGame = games[selectedIndex] ?? games[0] ?? null;
  const menuWidth = Math.max(26, Math.min(38, Math.floor(cabinetWidth * 0.34)));
  const detailWidth = Math.max(14, cabinetWidth - menuWidth - 8);
  const marquee = marqueeLines(selectedGame, detailWidth - 4);
  const attractText = blinkOn ? 'INSERT COIN TO LAUNCH' : 'PRESS ENTER TO PLAY';
  const attractBadge = blinkOn ? '1 CREDIT' : 'FREE PLAY';
  const hiScore = useMemo(() => cabinetHighScore(selectedGame), [selectedGame]);
  const divider = useMemo(() => repeatPattern(blinkOn ? '═' : '━', Math.max(18, cabinetWidth - 4)), [blinkOn, cabinetWidth]);
  const scanline = useMemo(() => repeatPattern(blinkOn ? '▓▒' : '▒▓', Math.max(18, detailWidth - 2)), [blinkOn, detailWidth]);
  const grille = useMemo(() => repeatPattern('▣═', Math.max(18, detailWidth - 2)), [detailWidth]);

  useEffect(() => {
    setSelectedIndex(current => Math.max(0, Math.min(current, Math.max(games.length - 1, 0))));
  }, [games.length]);

  useInput((input, key) => {
    if (activeGame) {
      return;
    }

    if (input === 'q' || input === 'Q' || input === 'g' || input === 'G' || key.escape) {
      onClose();
      return;
    }

    if (loading || loadError) {
      return;
    }

    if (key.upArrow) {
      setSelectedIndex(current => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex(current => Math.min(Math.max(games.length - 1, 0), current + 1));
      return;
    }

    if (key.return && selectedGame) {
      setActiveGameId(selectedGame.id);
    }
  });

  return (
    <SectionPanel
      title={activeGame ? `${activeGame.title} '${activeGame.year.slice(-2)}` : 'RALPHI ARCADE'}
      subtitle={activeGame ? 'PLAY' : blinkOn ? 'INSERT COIN' : 'PRESS START'}
      flexGrow={1}
    >
      {loading ? (
        <Box flexDirection="column" justifyContent="center" flexGrow={1}>
          <Spinner label="Loading arcade cabinets..." />
        </Box>
      ) : loadError ? (
        <Box flexDirection="column" justifyContent="center" flexGrow={1}>
          <Text color={palette.danger}>{loadError}</Text>
          <HintLine>Press Q, G, or Esc to leave the arcade.</HintLine>
        </Box>
      ) : activeGame && ActiveGameComponent ? (
        <ActiveGameComponent width={cabinetWidth - 4} height={cabinetHeight - 6} onExit={() => setActiveGameId(null)} />
      ) : (
        <Box flexDirection="column" flexGrow={1}>
          <Box justifyContent="space-between" flexShrink={0}>
            <Gradient colors={[palette.cyan, palette.accent, palette.yellow]}>
              <Text>{blinkOn ? '★ RALPHI NEON ARCADE ★' : '★ ASCII FLIPERAMA GRID ★'}</Text>
            </Gradient>
            <Text color={blinkOn ? palette.yellow : palette.green}>{attractBadge}</Text>
          </Box>
          <Box justifyContent="space-between" flexShrink={0}>
            <Text color={palette.green}>{`1UP 000000   HI-SCORE ${hiScore}   2UP 000000`}</Text>
            <Text color={palette.dim}>`ralphi/src/arcade`</Text>
          </Box>
          <Text color={palette.borderSoft}>{divider}</Text>
          <Box marginTop={1} flexGrow={1}>
            <Box width={menuWidth} flexShrink={0} flexDirection="column" borderStyle="round" borderColor={blinkOn ? palette.accent : palette.border} paddingX={1}>
              <Text color={palette.yellow}>GAME SELECT</Text>
              <Text color={palette.dim}>Choose a cabinet and hit Enter.</Text>
              <Box marginTop={1} flexDirection="column" flexGrow={1}>
                {games.map((game, index) => (
                  <CabinetChoice key={game.id} game={game} active={index === selectedIndex} />
                ))}
              </Box>
              <Text color={palette.green}>{blinkOn ? '► FREE PLAY ENABLED' : '► READY PLAYER ONE'}</Text>
            </Box>
            <Box marginLeft={2} flexGrow={1} flexDirection="column">
              <Box borderStyle="round" borderColor={blinkOn ? palette.cyan : palette.accentSoft} paddingX={2} flexDirection="column">
                <Text color={palette.yellow}>{attractText}</Text>
                <Text color={palette.borderSoft}>{scanline}</Text>
                <Box marginTop={1} flexDirection="column">
                  {marquee.map((line, index) => (
                    <Text key={`${line}-${index}`} color={index === 0 ? palette.accent : index === 1 ? palette.cyan : palette.yellow}>
                      {line.toUpperCase()}
                    </Text>
                  ))}
                </Box>
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.cyan}>{selectedGame?.tagline ?? 'No cabinet selected.'}</Text>
                  <Text color={palette.text}>{selectedGame?.description ?? 'Browse the line-up to wake the arcade.'}</Text>
                </Box>
              </Box>
              <Box marginTop={1} flexDirection="row" flexGrow={1}>
                <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor={palette.borderSoft} paddingX={1}>
                  <Text color={palette.yellow}>CABINET DATA</Text>
                  <Text color={palette.text}>{selectedGame ? `${selectedGame.title} · ${selectedGame.year}` : 'Unknown cabinet'}</Text>
                  <Text color={palette.green}>{`HI-SCORE ${hiScore}`}</Text>
                  <Text color={palette.dim}>{selectedGame ? `CAB ${String(selectedIndex + 1).padStart(2, '0')}` : 'CAB --'}</Text>
                  <Text color={palette.borderSoft}>{grille}</Text>
                </Box>
                <Box marginLeft={1} flexGrow={1} flexDirection="column" borderStyle="round" borderColor={palette.borderSoft} paddingX={1}>
                  <Text color={palette.cyan}>HOW TO PLAY</Text>
                  {selectedGame?.controls.length ? (
                    selectedGame.controls.map(control => (
                      <Text key={control} color={palette.text} wrap="truncate-end">
                        {`• ${control}`}
                      </Text>
                    ))
                  ) : (
                    <Text color={palette.dim}>No controls available.</Text>
                  )}
                </Box>
              </Box>
            </Box>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <HintLine>Use ↑ ↓ to browse cabinets. Press Enter to boot the highlighted game.</HintLine>
            <HintLine>Esc returns from a game to this menu. Q, G, or Esc leaves the arcade.</HintLine>
          </Box>
        </Box>
      )}
    </SectionPanel>
  );
}
