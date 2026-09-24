#!/usr/bin/env bash
# Arranca la API contra el clúster de desarrollo local.
#
# La clave maestra NO tiene valor por defecto a propósito: cifra las
# credenciales de todas las líneas, y un valor escrito en el repositorio acaba
# copiado a producción tarde o temprano. Si no hay una, se genera y se guarda
# en .data/, que está fuera del control de versiones.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p .data
if [ -z "${OMNI_MASTER_KEY:-}" ]; then
  if [ ! -f .data/master.key ]; then
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > .data/master.key
    chmod 600 .data/master.key
    echo "clave maestra de desarrollo generada en .data/master.key"
  fi
  OMNI_MASTER_KEY="$(cat .data/master.key)"
fi

export OMNI_MASTER_KEY
export DATABASE_URL="${DATABASE_URL:-postgres://omni@127.0.0.1:5440/omni_dev}"
export PORT="${PORT:-4000}"
export PUBLIC_URL="${PUBLIC_URL:-http://127.0.0.1:4000}"
export SANDBOX_ENABLED="${SANDBOX_ENABLED:-true}"
exec node apps/api/dist/main.js
