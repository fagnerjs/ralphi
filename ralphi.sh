#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/dist/cli.js" ]; then
  exec node "$SCRIPT_DIR/dist/cli.js" "$@"
fi

if [ -x "$SCRIPT_DIR/node_modules/.bin/tsx" ]; then
  exec "$SCRIPT_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/src/cli.tsx" "$@"
fi

echo "Ralphi is not ready yet." >&2
echo "Run: npm --prefix $SCRIPT_DIR install && npm --prefix $SCRIPT_DIR run build" >&2
exit 1
