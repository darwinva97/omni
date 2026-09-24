#!/usr/bin/env bash
# Clúster de Postgres propio, aislado del que sirva el sistema.
# No necesita root y no toca ninguna otra base de datos de la máquina.
set -euo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/17/bin}
BASE=${OMNI_PGBASE:-$HOME/.local/omni-pg}
PGDATA="$BASE/data"
PORT=${OMNI_PGPORT:-5440}

case "${1:-start}" in
  start)
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      mkdir -p "$BASE"
      "$PGBIN/initdb" -D "$PGDATA" -U omni --auth=trust --encoding=UTF8 --locale=C >/dev/null
      cat > "$PGDATA/postgresql.auto.conf" <<CONF
port = $PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$BASE'
fsync = off
synchronous_commit = off
CONF
    fi
    "$PGBIN/pg_ctl" -D "$PGDATA" -l "$BASE/server.log" start >/dev/null 2>&1 || true
    sleep 1
    for db in omni_dev omni_test; do
      psql -h 127.0.0.1 -p "$PORT" -U omni -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
        || psql -h 127.0.0.1 -p "$PORT" -U omni -d postgres -c "CREATE DATABASE $db" >/dev/null
    done
    "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PORT"
    ;;
  stop)  "$PGBIN/pg_ctl" -D "$PGDATA" stop >/dev/null && echo "detenido" ;;
  *)     echo "uso: $0 {start|stop}" >&2; exit 1 ;;
esac
