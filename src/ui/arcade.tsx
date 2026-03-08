import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';

import { loadArcadeGames } from '../arcade/loader.js';
import type { ArcadeGameDefinition } from '../arcade/types.js';
import { ChoiceRow, HintLine, SectionPanel } from './components.js';
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

export function ArcadeCabinet({ maxWidth, maxHeight, onClose }: ArcadeCabinetProps) {
  const [games, setGames] = useState<ArcadeGameDefinition[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  const cabinetWidth = Math.max(40, maxWidth ?? 110);
  const cabinetHeight = Math.max(24, maxHeight ?? 36);
  const activeGame = games.find(game => game.id === activeGameId) ?? null;
  const ActiveGameComponent = activeGame?.component ?? null;
  const selectedGame = games[selectedIndex] ?? games[0] ?? null;
  const menuWidth = Math.max(24, Math.min(34, Math.floor(cabinetWidth * 0.34)));
  const marqueeWidth = Math.max(24, cabinetWidth - menuWidth - 6);
  const marquee = marqueeLines(selectedGame, marqueeWidth);

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
    <SectionPanel title={activeGame ? `${activeGame.title} '${activeGame.year.slice(-2)}` : 'ARCADE'} subtitle={activeGame ? 'PLAY' : 'INSERT COIN'} flexGrow={1}>
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
          <Box justifyContent="space-between">
            <Text color={palette.accent}>{`AUTOLOAD ACTIVE :: ${games.length} CABINET${games.length === 1 ? '' : 'S'} READY`}</Text>
            <Text color={palette.dim}>`ralph/src/arcade`</Text>
          </Box>
          <Box marginTop={1} flexGrow={1}>
            <Box width={menuWidth} flexShrink={0} flexDirection="column">
              {games.map((game, index) => (
                <ChoiceRow key={game.id} active={index === selectedIndex} label={`${game.title} '${game.year.slice(-2)}`} description={game.tagline} />
              ))}
            </Box>
            <Box marginLeft={2} flexGrow={1} flexDirection="column">
              <Box borderStyle="round" borderColor={palette.border} paddingX={2} flexDirection="column">
                {marquee.map(line => (
                  <Text key={line} color={palette.accent}>
                    {line}
                  </Text>
                ))}
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.text}>{selectedGame?.description ?? 'No cabinet selected.'}</Text>
                </Box>
              </Box>
              <Box marginTop={1} flexDirection="column">
                <Text color={palette.cyan}>Cabinet details</Text>
                <Text color={palette.text}>{selectedGame ? `${selectedGame.title} · ${selectedGame.year}` : 'Unknown cabinet'}</Text>
                {selectedGame?.controls.map(control => (
                  <Text key={control} color={palette.dim}>
                    {`• ${control}`}
                  </Text>
                ))}
              </Box>
            </Box>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <HintLine>Use ↑ ↓ to choose a game. Enter launches the selected cabinet.</HintLine>
            <HintLine>While a game is running, Esc returns to this menu. Q, G, or Esc closes the arcade from here.</HintLine>
          </Box>
        </Box>
      )}
    </SectionPanel>
  );
}
