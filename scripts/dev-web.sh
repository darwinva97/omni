#!/usr/bin/env bash
# Arranca el panel. Puerto propio, y aborta si está ocupado: esta máquina es
# compartida y lo que haya en un puerto puede no ser mío.
set -euo pipefail
cd "$(dirname "$0")/.."
PUERTO="${PORT:-4011}"
if (exec 3<>"/dev/tcp/127.0.0.1/$PUERTO") 2>/dev/null; then
  echo "el puerto $PUERTO ya está ocupado. No mato nada; usa PORT=<otro>." >&2
  exit 1
fi
export OMNI_API_URL="${OMNI_API_URL:-http://127.0.0.1:4010}"
cd apps/web
exec node_modules/.bin/next start -p "$PUERTO"
