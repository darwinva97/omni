import { matchesAny, type EventEnvelope } from "@omni/shared";
import type { JobQueue, Subscription } from "@omni/platform";
import { passesFilter, type WebhookFilter } from "./filter.js";
import { signWithTimestamp, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./signature.js";

export interface WebhookEndpoint {
  readonly id: string;
  readonly orgId: string;
  readonly lineId: string | null;
  readonly url: string;
  readonly events: readonly string[];
  readonly secret: string;
  readonly hmacEnabled: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  /** Retardo inicial del backoff. Un receptor propio tolera reintentos más vivos. */
  readonly backoffMs?: number;
  readonly filter?: WebhookFilter | null;
}

export interface DeliveryRecord {
  readonly endpointId: string;
  readonly orgId: string;
  readonly lineId: string | null;
  readonly event: string;
  readonly attempt: number;
  readonly status: "delivered" | "failed" | "dead";
  readonly responseStatus?: number;
  readonly responseBody?: string;
  readonly error?: string;
  readonly durationMs: number;
  readonly payload: unknown;
}

export interface DispatcherDeps {
  /** Endpoints vivos que podrían querer este evento. */
  readonly endpointsFor: (orgId: string, lineId: string) => Promise<readonly WebhookEndpoint[]>;
  /** Anota el intento. Un fallo tiene que ser CONSULTABLE, no solo un log. */
  readonly recordDelivery: (record: DeliveryRecord) => Promise<void>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface DeliveryJob {
  readonly endpoint: WebhookEndpoint;
  readonly envelope: EventEnvelope;
  readonly body: string;
}

export const WEBHOOK_QUEUE = "webhooks";

/**
 * Entrega de webhooks.
 *
 * Todo lo que sale hacia fuera pasa por la cola: reintentos con backoff, tope
 * de intentos y cola muerta. Nunca se hace una petición de red dentro del bucle
 * de ingesta, que era el patrón que perdía mensajes cuando el receptor iba lento.
 */
export class WebhookDispatcher {
  readonly #queue: JobQueue;
  readonly #deps: DispatcherDeps;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(queue: JobQueue, deps: DispatcherDeps) {
    this.#queue = queue;
    this.#deps = deps;
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#now = deps.now ?? (() => Date.now());
  }

  /** Decide destinatarios y encola. No hace red: vuelve enseguida. */
  async dispatch(envelope: EventEnvelope): Promise<number> {
    const endpoints = await this.#deps.endpointsFor(envelope.orgId, envelope.lineId);
    let queued = 0;

    for (const endpoint of endpoints) {
      if (!endpoint.enabled) continue;
      if (endpoint.lineId !== null && endpoint.lineId !== envelope.lineId) continue;
      // Lista vacía significa TODO, por contrato explícito del catálogo.
      if (!matchesAny(envelope.event, endpoint.events)) continue;
      // El filtro se aplica AQUÍ, antes de encolar. No es decorativo.
      if (!passesFilter(endpoint.filter, envelope)) continue;

      const body = JSON.stringify({
        event: envelope.event,
        lineId: envelope.lineId,
        orgId: envelope.orgId,
        timestamp: envelope.timestamp,
        data: envelope.data,
      });

      await this.#queue.enqueue<DeliveryJob>(
        WEBHOOK_QUEUE,
        { endpoint, envelope, body },
        {
          maxAttempts: endpoint.maxAttempts,
          backoffMs: endpoint.backoffMs ?? 1000,
          // Una partición por endpoint: un receptor lento no retrasa a los demás.
          partitionKey: `wh:${endpoint.id}`,
          idempotencyKey: `wh:${endpoint.id}:${envelope.id}`,
        },
      );
      queued++;
    }
    return queued;
  }

  /** Arranca el consumidor. Va en el proceso `worker`, no en la API. */
  startWorker(concurrency = 8): Subscription {
    return this.#queue.process<DeliveryJob>(
      WEBHOOK_QUEUE,
      async (job, ctx) => {
        const started = this.#now();
        const timestampSec = Math.floor(started / 1000);
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "user-agent": "omni-webhooks/1",
          [TIMESTAMP_HEADER]: String(timestampSec),
          [SIGNATURE_HEADER]: job.endpoint.hmacEnabled
            ? signWithTimestamp(job.body, job.endpoint.secret, timestampSec)
            : job.endpoint.secret,
          ...job.endpoint.headers,
        };

        // Un receptor que no responde no puede retener un trabajador para siempre.
        const abort = AbortSignal.timeout(job.endpoint.timeoutMs);
        let response: Response;
        try {
          response = await this.#fetch(job.endpoint.url, {
            method: "POST", headers, body: job.body, signal: abort,
          });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          await this.#deps.recordDelivery({
            endpointId: job.endpoint.id, orgId: job.envelope.orgId, lineId: job.envelope.lineId,
            event: job.envelope.event, attempt: ctx.attempt, status: "failed",
            error, durationMs: this.#now() - started, payload: job.envelope.data,
          });
          throw new Error(`entrega fallida: ${error}`);
        }

        const text = await response.text().catch(() => "");
        const durationMs = this.#now() - started;

        if (!response.ok) {
          await this.#deps.recordDelivery({
            endpointId: job.endpoint.id, orgId: job.envelope.orgId, lineId: job.envelope.lineId,
            event: job.envelope.event, attempt: ctx.attempt, status: "failed",
            responseStatus: response.status, responseBody: text.slice(0, 2000),
            durationMs, payload: job.envelope.data,
          });
          throw new Error(`el receptor respondió ${response.status}`);
        }

        await this.#deps.recordDelivery({
          endpointId: job.endpoint.id, orgId: job.envelope.orgId, lineId: job.envelope.lineId,
          event: job.envelope.event, attempt: ctx.attempt, status: "delivered",
          responseStatus: response.status, responseBody: text.slice(0, 2000),
          durationMs, payload: job.envelope.data,
        });
      },
      {
        concurrency,
        onDead: async (payload, ctx, error) => {
          const job = payload as DeliveryJob;
          await this.#deps.recordDelivery({
            endpointId: job.endpoint.id, orgId: job.envelope.orgId, lineId: job.envelope.lineId,
            event: job.envelope.event, attempt: ctx.attempt, status: "dead",
            error: error.message, durationMs: 0, payload: job.envelope.data,
          });
        },
      },
    );
  }
}
