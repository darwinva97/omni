#!/usr/bin/env bash
# Compila y reinicia los servicios. Es LA forma de desplegar un cambio.
#
# Existe porque los servicios corren `dist/`, no las fuentes: editar, pasar las
# pruebas (que usan las fuentes) y reiniciar deja corriendo el código viejo sin
# ninguna señal de que algo va mal. Ya pasó una vez, con un limitador de
# intentos que estaba escrito, probado y NO en marcha mientras el servicio ya
# estaba expuesto a internet.
set -euo pipefail
cd "$(dirname "$0")/.."

PAQUETES=(
  packages/shared packages/platform packages/db packages/storage
  packages/core packages/channels packages/plugins
  apps/engine apps/api apps/cli
)

echo "compilando…"
for p in "${PAQUETES[@]}"; do
  (cd "$p" && ../../node_modules/.bin/tsc -p tsconfig.json)
done
node packages/plugins/scripts/bundle.mjs

echo "compilando el panel…"
(cd apps/web && node_modules/.bin/next build >/dev/null)

echo "reiniciando…"
systemctl --user restart omni-api omni-web

# No se da por bueno hasta que responde: un reinicio que falla y no se
# comprueba es un despliegue que parece hecho y no lo está.
for i in $(seq 1 30); do
  if curl -fsS -m 2 http://127.0.0.1:4010/health >/dev/null 2>&1; then
    echo "API arriba"
    break
  fi
  [ "$i" = 30 ] && { echo "la API no respondió tras el reinicio" >&2; exit 1; }
  sleep 1
done
for i in $(seq 1 30); do
  if curl -fsS -m 2 -o /dev/null http://127.0.0.1:4011/ 2>&1 || [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 http://127.0.0.1:4011/)" = "307" ]; then
    echo "panel arriba"
    break
  fi
  [ "$i" = 30 ] && { echo "el panel no respondió tras el reinicio" >&2; exit 1; }
  sleep 1
done
echo "desplegado en https://omni.bezenti.com"
