/**
 * Cola de trabajos con reintentos.
 *
 * Existe porque el fallo más caro del gateway anterior era entregar webhooks
 * con un `fetch` suelto dentro del bucle de mensajes: sin reintentos, sin
 * backoff, sin tiempo límite, y bloqueando la ingesta cuando el receptor iba
 * lento. Todo lo que sale de aquí hacia fuera pasa por esta cola.
 */

export type JobId = string;

export interface EnqueueOptions {
  /**
   * Clave de partición. Los trabajos que la comparten se ejecutan EN ORDEN y
   * de uno en uno. Es lo que permite limitar el ritmo de envío por línea de
   * WhatsApp, que es la diferencia entre un número vivo y uno baneado.
   */
  readonly partitionKey?: string;
  /** Reintentos totales antes de darlo por muerto. */
  readonly maxAttempts?: number;
  /** Retardo inicial del backoff exponencial, en ms. */
  readonly backoffMs?: number;
  /** No ejecutar antes de este instante (epoch ms). */
  readonly runAt?: number;
  /**
   * Si ya hay un trabajo vivo con esta clave, no se encola otro y se devuelve
   * el existente. Cierra la carrera entre aceptar un envío y persistirlo.
   */
  readonly idempotencyKey?: string;
}

export interface JobContext {
  readonly id: JobId;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly enqueuedAt: number;
}

export type JobHandler<T> = (payload: T, ctx: JobContext) => Promise<void>;

export interface ProcessOptions {
  /** Trabajos simultáneos. Con partición, el límite es además uno por partición. */
  readonly concurrency?: number;
  /** Se llama cuando un trabajo agota sus intentos. Es la cola muerta. */
  readonly onDead?: (payload: unknown, ctx: JobContext, error: Error) => Promise<void>;
}

export interface Subscription {
  stop(): Promise<void>;
}

export interface JobQueue {
  enqueue<T>(queue: string, payload: T, opts?: EnqueueOptions): Promise<JobId>;
  process<T>(queue: string, handler: JobHandler<T>, opts?: ProcessOptions): Subscription;
  /** Trabajos pendientes, para health checks y para el panel. */
  depth(queue: string): Promise<number>;
  close(): Promise<void>;
}

/** Backoff exponencial con tope y una pizca de aleatoriedad. */
export function backoffDelay(attempt: number, baseMs: number, capMs = 60 * 60 * 1000): number {
  const exp = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), capMs);
  // El jitter evita que mil webhooks fallidos reintenten todos en el mismo instante.
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}
