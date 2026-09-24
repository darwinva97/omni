import type { Sql } from "postgres";
import {
  backoffDelay,
  type EnqueueOptions, type JobContext, type JobHandler, type JobId,
  type JobQueue, type ProcessOptions, type Subscription,
} from "../ports/job-queue.port.js";
import { ensurePlatformSchema } from "./ddl.js";

interface Row {
  id: string; payload: unknown; partition_key: string | null;
  attempt: number; max_attempts: number; backoff_ms: number; enqueued_at: Date;
}

/**
 * Cola sobre Postgres. Es lo que permite el perfil "sin más dependencias":
 * ni Redis ni broker, solo la base de datos que ya hace falta.
 *
 * El reclamo usa `FOR UPDATE SKIP LOCKED`, que es la forma correcta de que N
 * trabajadores compitan sin bloquearse ni repartirse el mismo trabajo.
 */
export class PostgresJobQueue implements JobQueue {
  readonly #sql: Sql;
  readonly #leaseSeconds: number;
  readonly #timers = new Set<NodeJS.Timeout>();
  #ready: Promise<void> | null = null;
  #closed = false;

  constructor(sql: Sql, opts: { leaseSeconds?: number } = {}) {
    this.#sql = sql;
    this.#leaseSeconds = opts.leaseSeconds ?? 60;
  }

  #ensure(): Promise<void> {
    this.#ready ??= ensurePlatformSchema(this.#sql);
    return this.#ready;
  }

  async enqueue<T>(queue: string, payload: T, opts: EnqueueOptions = {}): Promise<JobId> {
    await this.#ensure();
    const id = `job-${crypto.randomUUID()}`;
    const runAt = new Date(opts.runAt ?? Date.now());

    const rows = await this.#sql<{ id: string }[]>`
      INSERT INTO omni_job (id, queue, payload, partition_key, max_attempts, backoff_ms, run_at, idempotency_key)
      VALUES (${id}, ${queue}, ${this.#sql.json(payload as never)}, ${opts.partitionKey ?? null},
              ${opts.maxAttempts ?? 5}, ${opts.backoffMs ?? 1000}, ${runAt}, ${opts.idempotencyKey ?? null})
      ON CONFLICT DO NOTHING
      RETURNING id`;

    if (rows.length > 0) return rows[0]!.id;

    // El índice único rechazó el insert: ya hay un trabajo vivo con esa clave.
    const existing = await this.#sql<{ id: string }[]>`
      SELECT id FROM omni_job
      WHERE queue = ${queue} AND idempotency_key = ${opts.idempotencyKey ?? null} AND NOT done
      LIMIT 1`;
    if (existing.length > 0) return existing[0]!.id;
    throw new Error("no se pudo encolar el trabajo");
  }

  process<T>(queue: string, handler: JobHandler<T>, opts: ProcessOptions = {}): Subscription {
    const concurrency = opts.concurrency ?? 4;
    let stopped = false;
    let running = 0;

    const tick = async (): Promise<void> => {
      if (stopped || this.#closed) return;
      while (running < concurrency) {
        const row = await this.#claim(queue).catch(() => null);
        if (!row) break;
        running++;
        void this.#run(row, handler as JobHandler<unknown>, opts).finally(() => { running--; });
      }
    };

    const interval = setInterval(() => void tick(), 20);
    this.#timers.add(interval);
    void this.#ensure().then(() => tick());

    return {
      stop: async () => {
        stopped = true;
        clearInterval(interval);
        this.#timers.delete(interval);
        while (running > 0) await new Promise((r) => setTimeout(r, 10));
      },
    };
  }

  /**
   * Reclama un trabajo. Las dos condiciones sobre `partition_key` son las que
   * dan orden dentro de una partición: no se toca una partición que ya tiene
   * algo en vuelo, y dentro de ella solo se coge el más antiguo.
   */
  async #claim(queue: string): Promise<Row | null> {
    const rows = await this.#sql<Row[]>`
      UPDATE omni_job SET
        claimed_until = now() + ${this.#leaseSeconds} * interval '1 second',
        attempt = attempt + 1
      WHERE id = (
        SELECT j.id FROM omni_job j
        WHERE j.queue = ${queue}
          AND NOT j.done
          AND j.run_at <= now()
          AND (j.claimed_until IS NULL OR j.claimed_until < now())
          AND (
            j.partition_key IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM omni_job b
              WHERE b.partition_key = j.partition_key AND NOT b.done
                AND b.claimed_until IS NOT NULL AND b.claimed_until >= now()
            )
          )
          AND (
            j.partition_key IS NULL
            OR j.seq = (
              SELECT MIN(o.seq) FROM omni_job o
              WHERE o.partition_key = j.partition_key AND NOT o.done AND o.run_at <= now()
            )
          )
        ORDER BY j.run_at, j.seq
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, payload, partition_key, attempt, max_attempts, backoff_ms, enqueued_at`;
    return rows[0] ?? null;
  }

  async #run(row: Row, handler: JobHandler<unknown>, opts: ProcessOptions): Promise<void> {
    const ctx: JobContext = {
      id: row.id, attempt: row.attempt,
      maxAttempts: row.max_attempts, enqueuedAt: row.enqueued_at.getTime(),
    };
    try {
      await handler(row.payload, ctx);
      await this.#sql`UPDATE omni_job SET done = true, claimed_until = NULL WHERE id = ${row.id}`;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (row.attempt >= row.max_attempts) {
        await this.#sql`
          UPDATE omni_job SET done = true, claimed_until = NULL, last_error = ${error.message}
          WHERE id = ${row.id}`;
        await opts.onDead?.(row.payload, ctx, error);
      } else {
        const next = new Date(Date.now() + backoffDelay(row.attempt, row.backoff_ms));
        await this.#sql`
          UPDATE omni_job SET run_at = ${next}, claimed_until = NULL, last_error = ${error.message}
          WHERE id = ${row.id}`;
      }
    }
  }

  async depth(queue: string): Promise<number> {
    await this.#ensure();
    const rows = await this.#sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM omni_job WHERE queue = ${queue} AND NOT done`;
    return Number(rows[0]?.n ?? 0);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const t of this.#timers) clearInterval(t);
    this.#timers.clear();
  }
}
