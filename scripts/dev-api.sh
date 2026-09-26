#!/usr/bin/env bash
# Arranca la API contra el clúster de desarrollo local.
#
# La clave maestra NO tiene valor por defecto a propósito: cifra las
# credenciales de todas las líneas, y un valor escrito en el repositorio acaba
# copiado a producción tarde o temprano. Si no hay una, se genera y se guarda
# en .data/, que está fuera del control de versiones.
#
# El puerto es 4010 y no 4000 a propósito: esta máquina es compartida y el 4000
# lo usa cualquiera. Si está ocupado, NO se mata lo que haya — se aborta y se
# elige otro con PORT=.
set -euo pipefail
cd "$(dirname "$0")/.."

PUERTO="${PORT:-4010}"
if (exec 3<>"/dev/tcp/127.0.0.1/$PUERTO") 2>/dev/null; then
  echo "el puerto $PUERTO ya está ocupado." >&2
  echo "No mato nada: en esta máquina hay procesos de otros. Usa PORT=<otro>." >&2
  exit 1
fi

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
export PORT="${PORT:-4010}"
export PUBLIC_URL="${PUBLIC_URL:-http://127.0.0.1:4010}"
export SANDBOX_ENABLED="${SANDBOX_ENABLED:-true}"
exec node apps/api/dist/main.js
