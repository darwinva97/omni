import type { Sql } from "postgres";

/**
 * DDL propia de la plataforma. Vive aquí y no en `@omni/db` para que el
 * paquete sea autónomo: quien use la cola de Postgres no arrastra el esquema
 * de dominio entero.
 */
export const PLATFORM_DDL = `
CREATE TABLE IF NOT EXISTS omni_job (
  id              text PRIMARY KEY,
  seq             bigserial NOT NULL,
  queue           text NOT NULL,
  payload         jsonb NOT NULL,
  partition_key   text,
  attempt         integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  backoff_ms      integer NOT NULL DEFAULT 1000,
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  run_at          timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,
  claimed_until   timestamptz,
  done            boolean NOT NULL DEFAULT false,
  last_error      text
);
-- El índice que hace barato reclamar: solo mira lo pendiente.
CREATE INDEX IF NOT EXISTS omni_job_claimable_idx
  ON omni_job (queue, run_at, seq) WHERE NOT done;
CREATE INDEX IF NOT EXISTS omni_job_partition_idx
  ON omni_job (partition_key, seq) WHERE NOT done AND partition_key IS NOT NULL;
-- La idempotencia es una restricción de la BASE DE DATOS, no una comprobación
-- en el código: dos procesos encolando a la vez no pueden duplicar.
CREATE UNIQUE INDEX IF NOT EXISTS omni_job_idempotency_idx
  ON omni_job (queue, idempotency_key) WHERE idempotency_key IS NOT NULL AND NOT done;

CREATE TABLE IF NOT EXISTS omni_kv (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS omni_kv_expiry_idx ON omni_kv (expires_at) WHERE expires_at IS NOT NULL;
`;

export async function ensurePlatformSchema(sql: Sql): Promise<void> {
  await sql.unsafe(PLATFORM_DDL);
}
