import process from 'node:process';

import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

export interface TerminalViewport {
  columns: number;
  rows: number;
}

type TtyStream = NodeJS.WriteStream & {
  columns?: number;
  rows?: number;
  isTTY?: boolean;
};

function asTtyStream(stream: NodeJS.WritableStream): TtyStream {
  return stream as TtyStream;
}

export function readTerminalViewport(stream: NodeJS.WritableStream = process.stdout): TerminalViewport {
  const tty = asTtyStream(stream);
  const columns = tty.columns ?? process.stdout.columns ?? 80;
  const rows = tty.rows ?? process.stdout.rows ?? 24;

  return {
    columns: columns > 0 ? columns : 80,
    rows: rows > 0 ? rows : 24
  };
}

export function useTerminalViewport(): TerminalViewport {
  const { stdout } = useStdout();
  const [viewport, setViewport] = useState<TerminalViewport>(() => readTerminalViewport(stdout));

  useEffect(() => {
    const tty = asTtyStream(stdout);
    const updateViewport = () => {
      setViewport(readTerminalViewport(tty));
    };

    updateViewport();

    if (!tty.isTTY) {
      return;
    }

    tty.on('resize', updateViewport);

    return () => {
      tty.removeListener('resize', updateViewport);
    };
  }, [stdout]);

  return viewport;
}

export function enterFullscreenTerminal(stream: NodeJS.WriteStream = process.stdout): () => void {
  if (!stream.isTTY) {
    return () => {};
  }

  let restored = false;
  stream.write('\u001B[?1049h\u001B[2J\u001B[H');

  return () => {
    if (restored || !stream.isTTY) {
      return;
    }

    restored = true;
    stream.write('\u001B[2J\u001B[H\u001B[?1049l');
  };
}
