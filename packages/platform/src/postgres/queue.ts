import type { Sql } from "postgres";
import {
  backoffDelay,
  type EnqueueOptions, type JobContext, type JobHandler, type JobId,
  type JobQueue, type ProcessOptions, type Subscription,
} from "../ports/job-queue.port.js";
import { ensurePlatformSchema } from "./ddl.js";

interface Row {
  id: string; payload: unknown; partition_key: string | null;
  attempt: number; max_attempts: number; backoff_ms: number;
  /**
   * Puede llegar como `Date` o como cadena: los parseadores de tipo de
   * postgres.js dependen de cómo se haya configurado la conexión, y la API
   * comparte la suya con Drizzle. No se da por supuesto el tipo.
   */
  enqueued_at: Date | string | number;
}

const MIN_PAUSA_MS = 20;
const MAX_PAUSA_MS = 500;

function toMillis(v: Date | string | number): number {
  if (v instanceof Date) return v.getTime();
  const parsed = new Date(v).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
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
  /** Quien procesa cada cola en este proceso: encolar lo despierta sin esperar a la pausa. */
  readonly #despiertos = new Map<string, Set<() => void>>();
  #ultimaPurga = 0;
  #ready: Promise<void> | null = null;
  #closed = false;

  constructor(sql: Sql, opts: { leaseSeconds?: number } = {}) {
    this.#sql = sql;
    this.#leaseSeconds = opts.leaseSeconds ?? 60;
  }

  #ensure(): Promise<void> {
    // Un fallo pasajero no se queda guardado: sin esto, una vez rechazada, la
    // cola no volvía a encolar nada hasta reiniciar el proceso.
    this.#ready ??= ensurePlatformSchema(this.#sql).catch((err: unknown) => {
      this.#ready = null;
      throw err;
    });
    return this.#ready;
  }

  async enqueue<T>(queue: string, payload: T, opts: EnqueueOptions = {}): Promise<JobId> {
    await this.#ensure();
    const id = `job-${crypto.randomUUID()}`;
    // Igual que en el KV: se manda un desplazamiento en milisegundos y la suma
    // la hace Postgres, para que todos los nodos compartan un solo reloj.
    const delayMs = Math.max(0, (opts.runAt ?? Date.now()) - Date.now());

    /*
     * El payload viaja como TEXTO y Postgres lo convierte a jsonb.
     *
     * Pasar el objeto y dejar que el cliente infiera el tipo funcionaba solo a
     * veces: postgres.js deduce el tipo de la descripción de la sentencia
     * preparada, y cuando esa descripción no está disponible manda el objeto en
     * crudo y revienta. Serializar a cadena SIN el cast tampoco vale: entonces
     * el cliente la codifica otra vez y el trabajador recibe una cadena en vez
     * de su objeto. Con el parámetro declarado texto no hay inferencia que
     * pueda fallar ni doble codificación.
     */
    const rows = await this.#sql<{ id: string }[]>`
      INSERT INTO omni_job (id, queue, payload, partition_key, max_attempts, backoff_ms, run_at, idempotency_key)
      VALUES (${id}, ${queue}, ${JSON.stringify(payload)}::text::jsonb, ${opts.partitionKey ?? null},
              ${opts.maxAttempts ?? 5}, ${opts.backoffMs ?? 1000},
              now() + ${delayMs}::bigint * interval '1 millisecond', ${opts.idempotencyKey ?? null})
      ON CONFLICT DO NOTHING
      RETURNING id`;

    if (rows.length > 0) {
      for (const d of this.#despiertos.get(queue) ?? []) d();
      void this.#purgar();
      return rows[0]!.id;
    }

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
    /*
     * Pausa entre consultas: 20 ms mientras hay trabajo y, si no encuentra
     * nada, el doble cada vez hasta medio segundo. Antes preguntaba cada 20 ms
     * siempre: con tres colas eran ~150 consultas por segundo a la base sin
     * un solo mensaje (medido en producción: un 10 % de CPU constante). Lo que
     * se encola en este proceso despierta la cola al momento (`#despertar`), así
     * que la espera larga solo la notan los reintentos programados y lo que
     * encole otro proceso.
     */
    let pausa = MIN_PAUSA_MS;
    let timer: NodeJS.Timeout | null = null;
    let enMarcha = false;

    const programar = (ms: number): void => {
      if (stopped || this.#closed) return;
      if (timer) { clearTimeout(timer); this.#timers.delete(timer); }
      timer = setTimeout(() => { timer = null; void tick(); }, ms);
      this.#timers.add(timer);
    };

    const tick = async (): Promise<void> => {
      if (stopped || this.#closed || enMarcha) return;
      enMarcha = true;
      let encontrados = 0;
      try {
        while (running < concurrency) {
          const row = await this.#claim(queue).catch(() => null);
          if (!row) break;
          encontrados++;
          running++;
          /*
           * Sin nadie que espere esta promesa, un rechazo suyo tumba el proceso.
           * `#run` captura lo que lance el trabajo, pero no lo que falle al
           * APUNTAR el resultado —la base caída o cerrándose—. Ese trabajo no se
           * pierde: su arrendamiento vence y se vuelve a reclamar.
           */
          void this.#run(row, handler as JobHandler<unknown>, opts)
            .catch(() => {})
            .finally(() => {
              running--;
              // Al liberar un hueco puede haber más esperando.
              pausa = MIN_PAUSA_MS;
              programar(0);
            });
        }
      } finally {
        enMarcha = false;
      }
      pausa = encontrados > 0 || running >= concurrency ? MIN_PAUSA_MS : Math.min(pausa * 2, MAX_PAUSA_MS);
      programar(pausa);
    };

    const despertar = (): void => {
      pausa = MIN_PAUSA_MS;
      if (!enMarcha) programar(0);
    };
    const lista = this.#despiertos.get(queue) ?? new Set<() => void>();
    lista.add(despertar);
    this.#despiertos.set(queue, lista);

    // Si falla, se vuelve a intentar en la siguiente pausa.
    void this.#ensure().then(() => tick()).catch(() => programar(pausa));

    return {
      stop: async () => {
        stopped = true;
        lista.delete(despertar);
        if (timer) { clearTimeout(timer); this.#timers.delete(timer); }
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
    /*
     * TODO lo que pueda lanzar va DENTRO del try.
     *
     * Con la construcción del contexto fuera, un fallo ahí dejaba el trabajo
     * reclamado para siempre: sin ejecutarse, sin error anotado y sin volver a
     * la cola cuando venciera el arrendamiento. Los trabajos se filtraban de uno
     * en uno y en silencio, que es la peor forma de perderlos.
     */
    let ctx: JobContext = { id: row.id, attempt: row.attempt, maxAttempts: row.max_attempts, enqueuedAt: 0 };
    try {
      ctx = { ...ctx, enqueuedAt: toMillis(row.enqueued_at) };
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
        const delayMs = backoffDelay(row.attempt, row.backoff_ms);
        await this.#sql`
          UPDATE omni_job SET
            run_at = now() + ${delayMs}::bigint * interval '1 millisecond',
            claimed_until = NULL, last_error = ${error.message}
          WHERE id = ${row.id}`;
      }
    }
  }

  /**
   * Los trabajos terminados se quedaban para siempre (cada foto o audio de
   * WhatsApp deja uno). Una vez por hora se borran los de más de 7 días: el
   * índice de reclamo ya los excluía, pero ocupaban disco y copias.
   */
  async #purgar(): Promise<void> {
    const ahora = Date.now();
    if (ahora - this.#ultimaPurga < 60 * 60_000) return;
    this.#ultimaPurga = ahora;
    await this.#sql`DELETE FROM omni_job WHERE done AND run_at < now() - interval '7 days'`.catch(() => {});
  }

  async depth(queue: string): Promise<number> {
    await this.#ensure();
    const rows = await this.#sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM omni_job WHERE queue = ${queue} AND NOT done`;
    return Number(rows[0]?.n ?? 0);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#despiertos.clear();
    this.#timers.clear();
  }
}
