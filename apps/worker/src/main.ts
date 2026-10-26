import { and, eq, isNull, or } from "drizzle-orm";
import { WebhookDispatcher, type DeliveryRecord, type WebhookEndpoint } from "@omni/core";
import {
  PostgresJobQueue, ensurePlatformSchema, MemoryJobQueue,
  type JobQueue, type Subscription,
} from "@omni/platform";
import { createDatabase, webhookDeliveryTable, webhookEndpointTable } from "@omni/db";
import { runMaintenance } from "@omni/db";

/**
 * Proceso trabajador.
 *
 * Saca de la API lo que no debe correr dentro de ella: la entrega de webhooks
 * y el mantenimiento periódico. La API atiende peticiones; si además entrega
 * webhooks, una ráfaga de reintentos compite por el mismo bucle de eventos que
 * los usuarios.
 *
 * Escala en horizontal sin más: varios trabajadores compiten por la misma cola
 * y `FOR UPDATE SKIP LOCKED` reparte el trabajo sin duplicarlo.
 */

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("falta DATABASE_URL");
  process.exit(1);
}

const concurrencia = Number(process.env["WORKER_CONCURRENCY"] ?? 8);
const intervaloMantenimientoMs = Number(process.env["MAINTENANCE_INTERVAL_MS"] ?? 6 * 3600 * 1000);

const dbh = createDatabase(url);
await ensurePlatformSchema(dbh.sql);

const queue: JobQueue = process.env["WORKER_IN_MEMORY"] === "true"
  ? new MemoryJobQueue()
  : new PostgresJobQueue(dbh.sql);

const dispatcher = new WebhookDispatcher(queue, {
  endpointsFor: async (orgId, lineId): Promise<readonly WebhookEndpoint[]> => {
    const rows = await dbh.db
      .select()
      .from(webhookEndpointTable)
      .where(
        and(
          eq(webhookEndpointTable.orgId, orgId),
          eq(webhookEndpointTable.enabled, true),
          or(isNull(webhookEndpointTable.lineId), eq(webhookEndpointTable.lineId, lineId)),
        ),
      );
    return rows.map((r) => ({
      id: r.id, orgId: r.orgId, lineId: r.lineId, url: r.url,
      events: r.events, secret: r.secret, hmacEnabled: r.hmacEnabled,
      headers: r.headers ?? undefined, enabled: r.enabled,
      maxAttempts: r.maxAttempts, timeoutMs: r.timeoutMs,
      filter: (r.filter ?? null) as WebhookEndpoint["filter"],
    }));
  },
  recordDelivery: async (rec: DeliveryRecord): Promise<void> => {
    await dbh.db.insert(webhookDeliveryTable).values({
      id: crypto.randomUUID(), endpointId: rec.endpointId, orgId: rec.orgId,
      lineId: rec.lineId, event: rec.event, payload: rec.payload as never,
      attempt: rec.attempt, status: rec.status,
      responseStatus: rec.responseStatus ?? null, responseBody: rec.responseBody ?? null,
      error: rec.error ?? null, durationMs: rec.durationMs, completedAt: new Date(),
    });
  },
});

const suscripciones: Subscription[] = [dispatcher.startWorker(concurrencia)];

const mantenimiento = async (): Promise<void> => {
  try {
    const r = await runMaintenance(dbh.db);
    console.log(
      `mantenimiento: ${r.particiones} particiones · ` +
        `${r.entregasPurgadas} entregas purgadas · ${r.mediosCaducados} medios caducados`,
    );
  } catch (err) {
    // Un fallo de mantenimiento no puede tumbar la entrega de webhooks.
    console.error("mantenimiento falló:", err instanceof Error ? err.message : String(err));
  }
};

await mantenimiento();
const temporizador = setInterval(() => void mantenimiento(), intervaloMantenimientoMs);

console.log(`omni worker en marcha · concurrencia ${concurrencia}`);
console.log(`  mantenimiento cada ${Math.round(intervaloMantenimientoMs / 3600000)} h`);

const apagar = async (senal: string): Promise<void> => {
  console.log(`\n${senal}: terminando lo que está en vuelo…`);
  clearInterval(temporizador);
  // `stop()` espera a que acabe lo empezado: parar no es abortar a medias.
  await Promise.all(suscripciones.map((s) => s.stop().catch(() => {})));
  await queue.close().catch(() => {});
  await dbh.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", () => void apagar("SIGINT"));
process.on("SIGTERM", () => void apagar("SIGTERM"));
