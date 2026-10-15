#!/usr/bin/env bash
# Despliegue continuo: lleva a producción lo último de main cuando CI lo ha
# dado por bueno.
#
# Lo lanza cada minuto el temporizador omni-cd (despliegue/omni-cd.timer).
# Tira de GitHub en vez de que GitHub empuje aquí: no hay que abrir SSH ni dejar
# en GitHub una llave de esta máquina, y nunca sale nada que no esté en main
# con CI en verde.
#
# - Sin commits nuevos, no hace nada y no escribe nada.
# - Con CI aún corriendo, espera al minuto siguiente. Con CI en rojo, lo anota
#   una vez y no despliega.
# - Si el despliegue falla, vuelve al commit que había y lo despliega otra vez.
#   Ese commit se descarta: no se reintenta cada minuto, tumbando el servicio
#   cada vez. Se vuelve a intentar con el commit siguiente, o borrando
#   .data/cd-descartado.
# - Cada despliegue queda en GitHub, en «Deployments» del repositorio.
#
# Todo va dentro de una función a propósito: el propio despliegue reescribe
# este fichero, y bash lee los scripts sobre la marcha. La función se lee
# entera antes de empezar.
set -euo pipefail

principal() {
  cd "$(dirname "$0")/.."
  local repo=darwinva97/omni
  local url=https://omni.bezenti.com
  mkdir -p .data

  # Dos ticks del temporizador no despliegan a la vez.
  exec 9>.data/cd.lock
  flock -n 9 || return 0

  git fetch -q origin main
  local actual nuevo
  actual=$(git rev-parse HEAD)
  nuevo=$(git rev-parse origin/main)
  [ "$actual" = "$nuevo" ] && return 0
  [ "$(cat .data/cd-descartado 2>/dev/null)" = "$nuevo" ] && return 0

  local ci
  ci=$(gh api "repos/$repo/actions/workflows/ci.yml/runs?head_sha=$nuevo&event=push&per_page=1" \
    --jq '.workflow_runs[0] | "\(.status // "sin-ejecutar") \(.conclusion // "-")"')
  case "$ci" in
    "completed success") ;;
    completed*) avisar "$nuevo" "CI en rojo ($ci) para ${nuevo:0:7}: no se despliega"; return 0 ;;
    *) return 0 ;;
  esac

  # Producción no se toca a mano. Si alguien lo hizo, mejor parar que pisarlo.
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    avisar "$nuevo" "hay cambios sin cometer en $(pwd): no se despliega ${nuevo:0:7}"
    return 1
  fi
  if ! git merge-base --is-ancestor HEAD "$nuevo"; then
    avisar "$nuevo" "HEAD no es un antecesor de origin/main: no se despliega ${nuevo:0:7}"
    return 1
  fi

  local cambios
  cambios=$(git diff --name-only "$actual" "$nuevo")

  # Lo que no entra en lo que corre —los SDK, la documentación, CI— no
  # justifica reiniciar la API, que tira y rehace las sesiones de WhatsApp.
  if ! grep -qE '^(apps/|packages/|scripts/despliegue\.sh$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|turbo\.json$|tsconfig[^/]*\.json$)' <<<"$cambios"; then
    git merge -q --ff-only "$nuevo"
    echo "$(date -Is) ${nuevo:0:7}: nada que desplegar, solo se avanza"
    return 0
  fi

  echo "$(date -Is) desplegando ${nuevo:0:7} (antes ${actual:0:7})"
  local despliegue
  despliegue=$(printf '{"ref":"%s","environment":"production","auto_merge":false,"required_contexts":[],"description":"omni-cd"}' "$nuevo" \
    | gh api "repos/$repo/deployments" --input - --jq .id 2>/dev/null || true)
  estado "$repo" "$despliegue" in_progress "desplegando" "$url"

  local lockfile=""
  grep -qx 'pnpm-lock.yaml' <<<"$cambios" && lockfile=1

  git merge -q --ff-only "$nuevo"
  if instalar "$lockfile" && scripts/despliegue.sh; then
    estado "$repo" "$despliegue" success "desplegado" "$url"
    echo "$(date -Is) ${nuevo:0:7} desplegado"
    return 0
  fi

  echo "$(date -Is) falló el despliegue de ${nuevo:0:7}; vuelvo a ${actual:0:7}"
  echo "$nuevo" > .data/cd-descartado
  git reset -q --hard "$actual"
  if instalar "$lockfile" && scripts/despliegue.sh; then
    estado "$repo" "$despliegue" failure "falló; sigue en producción ${actual:0:7}" "$url"
  else
    estado "$repo" "$despliegue" error "falló y la vuelta a ${actual:0:7} también" "$url"
  fi
  return 1
}

# Las dependencias solo se reinstalan si cambió el lockfile.
instalar() {
  [ -z "$1" ] || pnpm install --frozen-lockfile
}

# Un aviso por commit y motivo, no uno por minuto.
avisar() {
  local marca="$1 $2"
  [ "$(cat .data/cd-aviso 2>/dev/null)" = "$marca" ] && return 0
  echo "$marca" > .data/cd-aviso
  echo "$(date -Is) $2" >&2
}

# Que GitHub no conteste no es motivo para no desplegar.
estado() {
  [ -n "$2" ] || return 0
  gh api "repos/$1/deployments/$2/statuses" -f state="$3" -f description="$4" \
    -f environment_url="$5" -F auto_inactive=true >/dev/null 2>&1 || true
}

principal "$@"
