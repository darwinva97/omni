import { BaileysDriver, CloudDriver, SandboxDriver, type ChannelDriver } from "@omni/channels";
import { WebhookDispatcher, type DeliveryRecord, type WebhookEndpoint } from "@omni/core";
import {
  MemoryBus, MemoryJobQueue, MemoryKv,
  PostgresBus, PostgresJobQueue, PostgresKv,
  ensurePlatformSchema,
  type Bus, type JobQueue, type Kv, type Subscription,
} from "@omni/platform";
import { createDatabase, migrate, webhookDeliveryTable, webhookEndpointTable, type DbHandle } from "@omni/db";
import { EngineRuntime, SecretBox } from "@omni/engine";
import { LocalStorage, S3Storage, type Storage } from "@omni/storage";
import { and, eq, or, isNull } from "drizzle-orm";
import type { Config } from "./config.js";

export interface Container {
  readonly config: Config;
  readonly storage: Storage;
  readonly dbh: DbHandle;
  readonly queue: JobQueue;
  readonly kv: Kv;
  readonly bus: Bus;
  readonly runtime: EngineRuntime;
  readonly dispatcher: WebhookDispatcher;
  readonly sandbox: SandboxDriver | null;
  readonly drivers: readonly ChannelDriver[];
  shutdown(): Promise<void>;
}

export interface BuildOptions {
  /** Drivers extra. El sandbox se añade solo cuando está habilitado. */
  readonly drivers?: readonly ChannelDriver[];
  /** Permite inyectar un `fetch` en las pruebas sin tocar la red. */
  readonly fetchImpl?: typeof fetch;
  readonly runMigrations?: boolean;
  /** Fuerza los drivers en memoria, aunque haya Postgres. Solo para pruebas. */
  readonly inMemoryPlatform?: boolean;
  /** Reanudar las líneas con credenciales al arrancar. Por defecto, sí. */
  readonly resumeLines?: boolean;
}

export async function buildContainer(config: Config, opts: BuildOptions = {}): Promise<Container> {
  if (opts.runMigrations !== false) await migrate(config.DATABASE_URL);

  const dbh = createDatabase(config.DATABASE_URL);
  await ensurePlatformSchema(dbh.sql);

  // Sin Redis, todo va sobre Postgres. Es la misma semántica, verificada por
  // la misma batería de contrato, así que el perfil barato no es un perfil peor.
  const useMemory = opts.inMemoryPlatform === true;
  const queue: JobQueue = useMemory ? new MemoryJobQueue() : new PostgresJobQueue(dbh.sql);
  const kv: Kv = useMemory ? new MemoryKv() : new PostgresKv(dbh.sql);
  const bus: Bus = useMemory ? new MemoryBus() : new PostgresBus(createDatabase(config.DATABASE_URL, { max: 2 }).sql);

  const dispatcher = new WebhookDispatcher(queue, {
    endpointsFor: async (orgId, lineId): Promise<readonly WebhookEndpoint[]> => {
      const rows = await dbh.db
        .select()
        .from(webhookEndpointTable)
        .where(
          and(
            eq(webhookEndpointTable.orgId, orgId),
            eq(webhookEndpointTable.enabled, true),
            // Un endpoint sin línea escucha a toda la organización.
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
        error: rec.error ?? null, durationMs: rec.durationMs,
        completedAt: new Date(),
      });
    },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  const storage: Storage = config.S3_BUCKET
    ? new S3Storage({
        bucket: config.S3_BUCKET,
        region: config.S3_REGION,
        ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
        accessKeyId: config.S3_ACCESS_KEY_ID!,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
      })
    : new LocalStorage({
        directory: config.MEDIA_DIR,
        // La clave maestra ya es un secreto de despliegue; reutilizarla evita
        // una variable más que alguien olvidaría rotar.
        signingSecret: config.OMNI_MASTER_KEY,
      });

  const runtime = new EngineRuntime({
    db: dbh.db, queue, kv, bus, storage,
    box: new SecretBox(config.OMNI_MASTER_KEY),
    dispatcher,
  });

  const drivers: ChannelDriver[] = [];

  const sandbox = config.SANDBOX_ENABLED ? new SandboxDriver() : null;
  if (sandbox) drivers.push(sandbox);

  /*
   * Baileys conduce un cliente NO OFICIAL de WhatsApp. Va encendido por
   * defecto porque es la razón de ser del producto, pero el aviso de riesgo
   * aparece al arrancar y en el panel antes de enlazar cualquier número.
   */
  if (config.WHATSAPP_BAILEYS_ENABLED) drivers.push(new BaileysDriver());

  /*
   * El transporte OFICIAL de Meta. Va encendido siempre: no mantiene sockets
   * ni consume memoria por línea, y es el único apto para entornos regulados.
   * Una línea solo lo usa si su configuración trae las credenciales.
   */
  if (config.WHATSAPP_CLOUD_ENABLED) drivers.push(new CloudDriver());

  drivers.push(...(opts.drivers ?? []));
  for (const d of drivers) runtime.registerDriver(d);

  /*
   * El motor SIEMPRE consume su cola de salida.
   *
   * Es quien tiene los sockets vivos, así que nadie más puede enviar por él.
   * Apagarlo aquí dejaba los mensajes en `queued` para siempre en cuanto se
   * repartían los procesos: el trabajador de webhooks no puede sustituirlo.
   *
   * `RUN_WORKERS_IN_API` decide sólo lo que SÍ puede vivir en otro proceso:
   * la entrega de webhooks y el mantenimiento.
   */
  runtime.start();

  const workers: Subscription[] = [];
  if (config.RUN_WORKERS_IN_API) workers.push(dispatcher.startWorker());

  // Reanudar las líneas ANTES de aceptar tráfico: si no, los primeros envíos
  // tras un despliegue fallan porque su línea todavía no está conectada.
  if (opts.resumeLines !== false) {
    const { resumed, failed } = await runtime.resumeAll();
    if (resumed.length > 0) console.log(`líneas reanudadas: ${resumed.length}`);
    for (const f of failed) console.warn(`no se pudo reanudar "${f.lineId}": ${f.reason}`);
  }

  return {
    config, dbh, queue, kv, bus, runtime, dispatcher, sandbox, storage, drivers,
    shutdown: async () => {
      await Promise.all(workers.map((w) => w.stop().catch(() => {})));
      await runtime.stop();
      await queue.close().catch(() => {});
      await bus.close().catch(() => {});
      await dbh.close().catch(() => {});
    },
  };
}
