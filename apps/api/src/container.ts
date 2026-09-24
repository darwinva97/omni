import { SandboxDriver, type ChannelDriver } from "@omni/channels";
import { WebhookDispatcher, type DeliveryRecord, type WebhookEndpoint } from "@omni/core";
import {
  MemoryBus, MemoryJobQueue, MemoryKv,
  PostgresBus, PostgresJobQueue, PostgresKv,
  ensurePlatformSchema,
  type Bus, type JobQueue, type Kv, type Subscription,
} from "@omni/platform";
import { createDatabase, migrate, webhookDeliveryTable, webhookEndpointTable, type DbHandle } from "@omni/db";
import { EngineRuntime, SecretBox } from "@omni/engine";
import { and, eq, or, isNull } from "drizzle-orm";
import type { Config } from "./config.js";

export interface Container {
  readonly config: Config;
  readonly dbh: DbHandle;
  readonly queue: JobQueue;
  readonly kv: Kv;
  readonly bus: Bus;
  readonly runtime: EngineRuntime;
  readonly dispatcher: WebhookDispatcher;
  readonly sandbox: SandboxDriver | null;
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

  const runtime = new EngineRuntime({
    db: dbh.db, queue, kv, bus,
    box: new SecretBox(config.OMNI_MASTER_KEY),
    dispatcher,
  });

  const sandbox = config.SANDBOX_ENABLED ? new SandboxDriver() : null;
  if (sandbox) runtime.registerDriver(sandbox);
  for (const d of opts.drivers ?? []) runtime.registerDriver(d);

  runtime.start();
  const workers: Subscription[] = [dispatcher.startWorker()];

  // Reanudar las líneas ANTES de aceptar tráfico: si no, los primeros envíos
  // tras un despliegue fallan porque su línea todavía no está conectada.
  if (opts.resumeLines !== false) {
    const { resumed, failed } = await runtime.resumeAll();
    if (resumed.length > 0) console.log(`líneas reanudadas: ${resumed.length}`);
    for (const f of failed) console.warn(`no se pudo reanudar "${f.lineId}": ${f.reason}`);
  }

  return {
    config, dbh, queue, kv, bus, runtime, dispatcher, sandbox,
    shutdown: async () => {
      await Promise.all(workers.map((w) => w.stop().catch(() => {})));
      await runtime.stop();
      await queue.close().catch(() => {});
      await bus.close().catch(() => {});
      await dbh.close().catch(() => {});
    },
  };
}
