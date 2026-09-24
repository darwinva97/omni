import type { Sql } from "postgres";
import type { Kv } from "../ports/kv.port.js";
import { ensurePlatformSchema } from "./ddl.js";

/** KV sobre Postgres. Mismo contrato que el de memoria, incluida la expiración. */
export class PostgresKv implements Kv {
  readonly #sql: Sql;
  #ready: Promise<void> | null = null;

  constructor(sql: Sql) { this.#sql = sql; }

  #ensure(): Promise<void> {
    this.#ready ??= ensurePlatformSchema(this.#sql);
    return this.#ready;
  }

  #expiry(ttlSeconds?: number): Date | null {
    return ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null;
  }

  async get(key: string): Promise<string | null> {
    await this.#ensure();
    const rows = await this.#sql<{ value: string }[]>`
      SELECT value FROM omni_kv
      WHERE key = ${key} AND (expires_at IS NULL OR expires_at > now())`;
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.#ensure();
    await this.#sql`
      INSERT INTO omni_kv (key, value, expires_at) VALUES (${key}, ${value}, ${this.#expiry(ttlSeconds)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`;
  }

  async delete(key: string): Promise<void> {
    await this.#ensure();
    await this.#sql`DELETE FROM omni_kv WHERE key = ${key}`;
  }

  /**
   * Atómico en una sola sentencia: el `WHERE` del `DO UPDATE` solo deja pisar
   * una clave ya caducada, así que dos procesos simultáneos no pueden ganar ambos.
   */
  async setIfAbsent(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    await this.#ensure();
    const rows = await this.#sql<{ key: string }[]>`
      INSERT INTO omni_kv (key, value, expires_at) VALUES (${key}, ${value}, ${this.#expiry(ttlSeconds)})
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
        WHERE omni_kv.expires_at IS NOT NULL AND omni_kv.expires_at <= now()
      RETURNING key`;
    return rows.length > 0;
  }

  async increment(key: string, by = 1, ttlSeconds?: number): Promise<number> {
    await this.#ensure();
    const rows = await this.#sql<{ value: string }[]>`
      INSERT INTO omni_kv (key, value, expires_at) VALUES (${key}, ${String(by)}, ${this.#expiry(ttlSeconds)})
      ON CONFLICT (key) DO UPDATE SET
        value = (CASE
          WHEN omni_kv.expires_at IS NOT NULL AND omni_kv.expires_at <= now() THEN 0
          ELSE omni_kv.value::bigint END + ${by})::text,
        -- El TTL NO se renueva al incrementar: si no, una ventana de cuota
        -- con tráfico constante no caducaría nunca.
        expires_at = CASE
          WHEN omni_kv.expires_at IS NOT NULL AND omni_kv.expires_at <= now() THEN EXCLUDED.expires_at
          ELSE omni_kv.expires_at END
      RETURNING value`;
    return Number(rows[0]!.value);
  }

  async close(): Promise<void> { /* el pool lo cierra quien lo creó */ }
}
