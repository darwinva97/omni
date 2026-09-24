import {
  backoffDelay,
  type EnqueueOptions, type JobContext, type JobHandler, type JobId,
  type JobQueue, type ProcessOptions, type Subscription,
} from "../ports/job-queue.port.js";

interface Job {
  readonly id: JobId;
  readonly queue: string;
  readonly payload: unknown;
  readonly partitionKey: string | null;
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly enqueuedAt: number;
  readonly idempotencyKey: string | null;
  attempt: number;
  runAt: number;
  done: boolean;
  /** En vuelo. Sin esto, varios trabajadores reclaman el MISMO trabajo a la vez. */
  claimed: boolean;
}

/**
 * Cola en memoria. Es el driver del perfil sin dependencias y el que usan las
 * pruebas unitarias; implementa la MISMA semántica que el de Postgres —orden
 * por partición, backoff exponencial, cola muerta e idempotencia— para que un
 * test en memoria demuestre algo sobre producción.
 */
export class MemoryJobQueue implements JobQueue {
  readonly #jobs = new Map<JobId, Job>();
  readonly #byIdempotency = new Map<string, JobId>();
  readonly #busyPartitions = new Set<string>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #closed = false;
  #seq = 0;

  async enqueue<T>(queue: string, payload: T, opts: EnqueueOptions = {}): Promise<JobId> {
    if (this.#closed) throw new Error("la cola está cerrada");

    if (opts.idempotencyKey) {
      const existing = this.#byIdempotency.get(opts.idempotencyKey);
      // Un trabajo vivo con la misma clave no se duplica: se devuelve el que hay.
      if (existing && this.#jobs.get(existing)?.done === false) return existing;
    }

    const id = `job-${++this.#seq}`;
    const job: Job = {
      id, queue, payload,
      partitionKey: opts.partitionKey ?? null,
      maxAttempts: opts.maxAttempts ?? 5,
      backoffMs: opts.backoffMs ?? 1000,
      enqueuedAt: Date.now(),
      idempotencyKey: opts.idempotencyKey ?? null,
      attempt: 0,
      runAt: opts.runAt ?? Date.now(),
      done: false,
      claimed: false,
    };
    this.#jobs.set(id, job);
    if (opts.idempotencyKey) this.#byIdempotency.set(opts.idempotencyKey, id);
    return id;
  }

  process<T>(queue: string, handler: JobHandler<T>, opts: ProcessOptions = {}): Subscription {
    const concurrency = opts.concurrency ?? 4;
    let stopped = false;
    let running = 0;

    const tick = async (): Promise<void> => {
      if (stopped || this.#closed) return;
      while (running < concurrency) {
        const job = this.#claim(queue);
        if (!job) break;
        running++;
        void this.#run(job, handler as JobHandler<unknown>, opts).finally(() => {
          running--;
          job.claimed = false;
          if (job.partitionKey) this.#busyPartitions.delete(job.partitionKey);
        });
      }
    };

    const interval = setInterval(() => void tick(), 5);
    this.#timers.add(interval);
    void tick();

    return {
      stop: async () => {
        stopped = true;
        clearInterval(interval);
        this.#timers.delete(interval);
        // Esperar a que lo que ya empezó termine: parar no es abortar.
        while (running > 0) await new Promise((r) => setTimeout(r, 5));
      },
    };
  }

  #claim(queue: string): Job | null {
    const now = Date.now();
    for (const job of this.#jobs.values()) {
      if (job.done || job.claimed || job.queue !== queue || job.runAt > now) continue;
      // Orden por partición: como mucho un trabajo vivo por clave.
      if (job.partitionKey) {
        if (this.#busyPartitions.has(job.partitionKey)) continue;
        this.#busyPartitions.add(job.partitionKey);
      }
      job.claimed = true;
      job.attempt++;
      return job;
    }
    return null;
  }

  async #run(job: Job, handler: JobHandler<unknown>, opts: ProcessOptions): Promise<void> {
    const ctx: JobContext = {
      id: job.id, attempt: job.attempt,
      maxAttempts: job.maxAttempts, enqueuedAt: job.enqueuedAt,
    };
    try {
      await handler(job.payload, ctx);
      job.done = true;
      if (job.idempotencyKey) this.#byIdempotency.delete(job.idempotencyKey);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (job.attempt >= job.maxAttempts) {
        job.done = true;
        if (job.idempotencyKey) this.#byIdempotency.delete(job.idempotencyKey);
        // Agotar intentos no puede ser silencioso: alguien tiene que poder verlo.
        await opts.onDead?.(job.payload, ctx, error);
      } else {
        job.runAt = Date.now() + backoffDelay(job.attempt, job.backoffMs);
      }
    }
  }

  async depth(queue: string): Promise<number> {
    let n = 0;
    for (const job of this.#jobs.values()) if (!job.done && job.queue === queue) n++;
    return n;
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const t of this.#timers) clearInterval(t);
    this.#timers.clear();
  }
}
