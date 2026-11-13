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

function toMillis(v: Date | string | number): number {
  if (v instanceof Date) return v.getTime();
  const parsed = new Date(v).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Canal de `NOTIFY` por el que se avisa de un trabajo nuevo; la carga es el nombre de la cola. */
const WAKE_CHANNEL = "omni.job";

export interface PostgresJobQueueOptions {
  /** Duración del arrendamiento de un trabajo reclamado. */
  readonly leaseSeconds?: number;
  /** Primera espera tras encontrar la cola vacía. Se duplica en cada vuelta sin trabajo. */
  readonly idleMinMs?: number;
  /**
   * Tope de la espera sin trabajo. Es la red de seguridad: si se pierde un
   * aviso, ningún trabajo tarda más que esto en recogerse.
   */
  readonly idleMaxMs?: number;
  /**
   * Avisar entre procesos con `LISTEN`/`NOTIFY`. Ocupa una conexión dedicada
   * por proceso (la de `listen` de postgres.js), no una por cola.
   */
  readonly notifications?: boolean;
}

/** Un consumidor despierta ya (`0`) o dentro de `delayMs`, lo que llegue antes. */
type Waker = (delayMs: number) => void;

/**
 * Cola sobre Postgres. Es lo que permite el perfil "sin más dependencias":
 * ni Redis ni broker, solo la base de datos que ya hace falta.
 *
 * El reclamo usa `FOR UPDATE SKIP LOCKED`, que es la forma correcta de que N
 * trabajadores compitan sin bloquearse ni repartirse el mismo trabajo.
 *
 * Cuándo se reclama:
 *
 * - Con trabajo, sin pausa: se reclama hasta llenar `concurrency` y cada
 *   trabajo que termina vuelve a reclamar.
 * - Sin trabajo, la espera crece de `idleMinMs` a `idleMaxMs` duplicándose.
 *   Antes era un `setInterval` de 20 ms por cola: con Omni ocioso, cien o
 *   doscientas consultas por segundo contra `omni_job` y un tercio de núcleo
 *   en la API y otro tanto en Postgres, sin hacer nada.
 * - Encolar despierta: en el mismo proceso, directamente; entre procesos
 *   (API y worker separados), con `NOTIFY`. Si el `LISTEN` se cae, el tope de
 *   la espera garantiza que el trabajo se recoge igual, solo que más tarde.
 */
export class PostgresJobQueue implements JobQueue {
  readonly #sql: Sql;
  readonly #leaseSeconds: number;
  readonly #idleMinMs: number;
  readonly #idleMaxMs: number;
  readonly #notifications: boolean;
  /** Consumidores vivos de cada cola en este proceso. */
  readonly #wakers = new Map<string, Set<Waker>>();
  /** Cierre de cada suscripción viva, para que `close()` no deje temporizadores. */
  readonly #halts = new Set<() => void>();
  #ready: Promise<void> | null = null;
  #listener: Promise<{ unlisten(): Promise<void> } | null> | null = null;
  /** Una consulta de reclamo falló: al volver la base se rehace el `LISTEN`. */
  #dbTrouble = false;
  #closed = false;

  constructor(sql: Sql, opts: PostgresJobQueueOptions = {}) {
    this.#sql = sql;
    this.#leaseSeconds = opts.leaseSeconds ?? 60;
    this.#idleMinMs = Math.max(1, opts.idleMinMs ?? 20);
    this.#idleMaxMs = Math.max(this.#idleMinMs, opts.idleMaxMs ?? 1000);
    this.#notifications = opts.notifications ?? true;
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

  /** Despierta a los consumidores de `queue` en este proceso. */
  #wake(queue: string, delayMs = 0): void {
    for (const w of this.#wakers.get(queue) ?? []) w(delayMs);
  }

  #wakeAll(): void {
    for (const ws of this.#wakers.values()) for (const w of ws) w(0);
  }

  /**
   * Arranca (o rehace) el `LISTEN`. Nunca rechaza: si no se puede escuchar, la
   * cola sigue funcionando por sondeo y se reintenta cuando la base responda.
   *
   * postgres.js ya reconecta solo la conexión de `listen` y vuelve a llamar a
   * `onlisten`; aquí se despierta a todos en ese momento, porque mientras no
   * se escuchaba se pudo perder algún aviso.
   */
  #listen(): void {
    if (!this.#notifications || this.#closed) return;
    const previous = this.#listener;
    this.#listener = (async () => {
      const old = await previous;
      await old?.unlisten().catch(() => {});
      try {
        const l = await this.#sql.listen(WAKE_CHANNEL, (queue) => this.#wake(queue), () => this.#wakeAll());
        if (this.#closed) { await l.unlisten().catch(() => {}); return null; }
        return l;
      } catch {
        this.#dbTrouble = true;
        return null;
      }
    })();
  }

  /** Tras un reclamo que fue bien: si el `LISTEN` está caído o es sospechoso, se rehace. */
  #keepListening(): void {
    if (!this.#dbTrouble) return;
    this.#dbTrouble = false;
    this.#listen();
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
      /*
       * Avisar a quien consuma. Un trabajo diferido no avisa a otros procesos
       * (despertarían para no encontrar nada): lo recogen al vencer su espera,
       * como mucho `idleMaxMs` tarde. En este proceso sí se programa el
       * despertar a su hora. El aviso no hace fallar el encolado: el trabajo ya
       * está guardado y el sondeo lo encontrará igual.
       */
      this.#wake(queue, delayMs);
      if (this.#notifications && delayMs === 0) {
        await this.#sql.notify(WAKE_CHANNEL, queue).catch(() => {});
      }
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
    let idleMs = this.#idleMinMs;
    let timer: NodeJS.Timeout | null = null;
    let timerDue = 0;
    let ticking: Promise<void> | null = null;
    /** Llegó un despertar mientras se reclamaba: hay que volver a mirar. */
    let again = false;
    /**
     * Hora del despertar diferido más próximo (reintento o `runAt` encolado en
     * este proceso). Un despertar inmediato no debe borrarlo.
     */
    let deferredDue = Number.POSITIVE_INFINITY;

    const clearTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    /** Programa la próxima vuelta; si ya hay una antes, gana la más temprana. */
    const schedule = (delayMs: number): void => {
      if (stopped || this.#closed) return;
      const due = Date.now() + delayMs;
      if (timer && timerDue <= due) return;
      clearTimer();
      timerDue = due;
      timer = setTimeout(() => { timer = null; void tick(); }, delayMs);
    };

    const wake: Waker = (delayMs) => {
      if (stopped || this.#closed) return;
      // Un despertar diferido más allá del tope no aporta: el sondeo llega antes.
      if (delayMs > this.#idleMaxMs) return;
      if (delayMs > 0) deferredDue = Math.min(deferredDue, Date.now() + delayMs);
      if (delayMs <= 0 && ticking) { again = true; return; }
      schedule(Math.max(0, delayMs));
    };

    const claimLoop = async (): Promise<void> => {
      let claimedAny = false;
      let failed = false;
      try {
        await this.#ensure();
        while (!stopped && !this.#closed && running < concurrency) {
          const row = await this.#claim(queue).catch(() => { failed = true; return null; });
          if (!row) break;
          claimedAny = true;
          running++;
          /*
           * Sin nadie que espere esta promesa, un rechazo suyo tumba el
           * proceso. `#run` captura lo que lance el trabajo, pero no lo que
           * falle al APUNTAR el resultado —la base caída o cerrándose—. Ese
           * trabajo no se pierde: su arrendamiento vence y se vuelve a reclamar.
           *
           * Al terminar, se vuelve a reclamar enseguida: puede haber más
           * trabajo, o el siguiente de la misma partición acaba de quedar libre.
           * Si salió a reintentar, se despierta a la hora del reintento.
           */
          void this.#run(row, handler as JobHandler<unknown>, opts)
            .then((retryInMs) => { if (retryInMs !== null) wake(retryInMs); })
            .catch(() => {})
            .finally(() => { running--; wake(0); });
        }
      } catch {
        failed = true; // el esquema no está listo: se reintenta tras la espera
      }

      if (failed) this.#dbTrouble = true;
      else this.#keepListening();

      if (stopped || this.#closed) return;
      if (again) { again = false; schedule(0); return; }
      // Lleno: no hace falta temporizador, cada trabajo que termina despierta.
      if (running >= concurrency) return;
      if (claimedAny) idleMs = this.#idleMinMs;
      let wait = idleMs;
      const untilDeferred = deferredDue - Date.now();
      if (untilDeferred > 0) wait = Math.min(wait, untilDeferred);
      else deferredDue = Number.POSITIVE_INFINITY;
      schedule(wait);
      idleMs = Math.min(idleMs * 2, this.#idleMaxMs);
    };

    const tick = (): Promise<void> => {
      if (stopped || this.#closed) return Promise.resolve();
      if (ticking) { again = true; return ticking; }
      clearTimer();
      ticking = claimLoop().finally(() => { ticking = null; });
      return ticking;
    };

    const halt = (): void => {
      stopped = true;
      clearTimer();
      this.#wakers.get(queue)?.delete(wake);
      if (this.#wakers.get(queue)?.size === 0) this.#wakers.delete(queue);
      this.#halts.delete(halt);
    };

    let ws = this.#wakers.get(queue);
    if (!ws) this.#wakers.set(queue, (ws = new Set()));
    ws.add(wake);
    this.#halts.add(halt);
    if (this.#listener === null) this.#listen();
    void tick();

    return {
      stop: async () => {
        halt();
        // Un reclamo en vuelo puede traer un trabajo: se espera a que arranque
        // y a que termine, como antes.
        await ticking?.catch(() => {});
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

  /** Ejecuta un trabajo. Devuelve en cuántos ms toca reintentarlo, o `null` si no se reintenta. */
  async #run(row: Row, handler: JobHandler<unknown>, opts: ProcessOptions): Promise<number | null> {
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
      return null;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (row.attempt >= row.max_attempts) {
        await this.#sql`
          UPDATE omni_job SET done = true, claimed_until = NULL, last_error = ${error.message}
          WHERE id = ${row.id}`;
        await opts.onDead?.(row.payload, ctx, error);
        return null;
      } else {
        const delayMs = backoffDelay(row.attempt, row.backoff_ms);
        await this.#sql`
          UPDATE omni_job SET
            run_at = now() + ${delayMs}::bigint * interval '1 millisecond',
            claimed_until = NULL, last_error = ${error.message}
          WHERE id = ${row.id}`;
        return delayMs;
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
    for (const halt of [...this.#halts]) halt();
    const listener = this.#listener;
    this.#listener = null;
    const l = await listener?.catch(() => null);
    await l?.unlisten().catch(() => {});
  }
}
