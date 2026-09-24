#!/usr/bin/env bash
# Arranca la API contra el clúster de desarrollo local.
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://omni@127.0.0.1:5440/omni_dev}"
export OMNI_MASTER_KEY="${OMNI_MASTER_KEY:-CLAVE-DE-DESARROLLO-RETIRADA}"
export PORT="${PORT:-4000}"
export PUBLIC_URL="${PUBLIC_URL:-http://127.0.0.1:4000}"
export SANDBOX_ENABLED="${SANDBOX_ENABLED:-true}"
exec node apps/api/dist/main.js
