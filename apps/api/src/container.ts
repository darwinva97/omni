import type { EventEnvelope } from "@omni/shared";
import {
  BaileysDriver, CloudDriver, EmailDriver, SandboxDriver, TelegramDriver,
  WhatsappWebDriver, comprobarOpcionales, type ChannelDriver,
} from "@omni/channels";
import { Conversor } from "@omni/media";
import { makeImap, makeSmtp } from "./email-transport.js";
import { registroBaileys } from "./registro-baileys.js";
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
import { PluginRegistry } from "./plugins/registry.js";
import { Conversaciones } from "./crm/conversaciones.js";
import { Automatizaciones } from "./crm/automatizaciones.js";
import { hostApiPara } from "./plugins/api.js";
import { and, eq, or, isNull } from "drizzle-orm";
import type { Config } from "./config.js";

/** Versión del anfitrión, contra la que se valida `minHostVersion`. */
export const HOST_VERSION = "0.1.0";

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
  readonly plugins: PluginRegistry;
  readonly conversaciones: Conversaciones;
  readonly automatizaciones: Automatizaciones;
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
        /*
         * Las URLs firmadas salen ABSOLUTAS. La ruta las documenta como algo
         * que se puede pegar en un `<img>` o pasar a un tercero, y una URL
         * relativa solo vale dentro de nuestra propia página.
         */
        publicBase: `${config.PUBLIC_URL.replace(/\/+$/, "")}/v1/media`,
      });

  /*
   * El conversor se comprueba al arrancar, no al primer envío.
   *
   * Si ffmpeg no está, lo que graba un navegador no se puede convertir y los
   * envíos de audio o vídeo grabados se rechazarán con un motivo claro. Es
   * mejor saberlo aquí, en el arranque, que descubrirlo con un cliente
   * delante.
   */
  const conversor = new Conversor({ ffmpegPath: config.FFMPEG_PATH });
  const hayConversor = await conversor.disponible();
  if (!hayConversor) {
    console.warn(
      `ffmpeg no está en "${config.FFMPEG_PATH}": las notas de voz y los vídeos ` +
      "grabados en el navegador no se podrán convertir, y se rechazarán al enviarlos.",
    );
  }

  const runtime = new EngineRuntime({
    db: dbh.db, queue, kv, bus, storage,
    box: new SecretBox(config.OMNI_MASTER_KEY),
    dispatcher,
    ...(hayConversor ? { conversor } : {}),
  });

  const drivers: ChannelDriver[] = [];

  const sandbox = config.SANDBOX_ENABLED ? new SandboxDriver() : null;
  if (sandbox) drivers.push(sandbox);

  /*
   * Baileys conduce un cliente NO OFICIAL de WhatsApp. Va encendido por
   * defecto porque es la razón de ser del producto, pero el aviso de riesgo
   * aparece al arrancar y en el panel antes de enlazar cualquier número.
   */
  if (config.WHATSAPP_BAILEYS_ENABLED) {
    /*
     * Los pares opcionales de Baileys se comprueban AL ARRANCAR.
     *
     * Sin `audio-decode` las notas de voz se envían y no aparecen en ningún
     * cliente, sin más rastro que una línea de registro en `debug`. Costó una
     * tarde encontrarlo; que avise aquí cuesta un segundo.
     */
    const faltan = await comprobarOpcionales();
    for (const f of faltan) {
      console.warn(`falta "${f.paquete}": se romperá ${f.para} (${f.motivo})`);
    }
    drivers.push(new BaileysDriver({ logger: registroBaileys(config.LOG_LEVEL) }));
  }

  /*
   * El transporte OFICIAL de Meta. Va encendido siempre: no mantiene sockets
   * ni consume memoria por línea, y es el único apto para entornos regulados.
   * Una línea solo lo usa si su configuración trae las credenciales.
   */
  if (config.WHATSAPP_CLOUD_ENABLED) drivers.push(new CloudDriver());

  /*
   * whatsapp-web.js va APAGADO por defecto.
   *
   * Conduce un Chromium por línea: cuatrocientos megas frente a los sesenta de
   * Baileys. Encenderlo sin querer en un servidor pequeño lo tumba en cuanto se
   * enlazan tres números, así que se activa a propósito o no se activa.
   */
  if (config.WHATSAPP_WEB_ENABLED) {
    drivers.push(new WhatsappWebDriver({
      storage,
      ...(config.CHROMIUM_PATH ? { executablePath: config.CHROMIUM_PATH } : {}),
    }));
  }

  /*
   * Telegram: el primer canal que no es WhatsApp. Sondea con espera larga en
   * vez de mantener un socket, así que cuesta poco tenerlo encendido.
   */
  if (config.TELEGRAM_ENABLED) drivers.push(new TelegramDriver());

  /*
   * Correo. Las fábricas de SMTP e IMAP se inyectan desde aquí para que el
   * driver no dependa de ninguna biblioteca concreta y se pueda probar entero
   * contra un servidor falso.
   */
  if (config.EMAIL_ENABLED) {
    drivers.push(new EmailDriver({
      makeSmtp, makeImap,
      pollMs: config.EMAIL_POLL_SECONDS * 1000,
    }));
  }

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

  /*
   * Conversaciones y automatizaciones, enganchadas a la ingesta.
   *
   * El orden dentro del oyente importa: primero se abre o se actualiza la
   * conversación y después se evalúan las reglas, para que una condición sobre
   * el estado vea el estado de AHORA y no el de antes del mensaje.
   */
  const conversaciones = new Conversaciones(dbh.db);
  const automatizaciones = new Automatizaciones({
    db: dbh.db, runtime, conversaciones, kv,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  runtime.onEvent(async (envelope) => {
    await anotarConversacion(conversaciones, envelope).catch(() => {});
    await automatizaciones.despachar(envelope).catch(() => {});
  });

  /*
   * Los plugins se enganchan a la ingesta DESPUÉS del webhook y del bus: un
   * plugin lento o colgado no puede retrasar lo que ya estaba garantizado.
   */
  const plugins = new PluginRegistry({
    db: dbh.db,
    hostVersion: HOST_VERSION,
    api: (orgId) => hostApiPara(orgId, dbh.db, runtime, kv),
    bus,
    onLog: (nivel, mensaje) => {
      if (nivel === "error" || nivel === "warn") console.warn(mensaje);
    },
  });
  runtime.onEvent((envelope) => plugins.despachar(envelope));

  if (config.PLUGINS_ENABLED) {
    await plugins.escuchar();
    const { arrancados, fallidos } = await plugins.arrancarTodos();
    if (arrancados.length > 0) console.log(`plugins arrancados: ${arrancados.join(", ")}`);
    for (const f of fallidos) console.warn(`el plugin "${f.id}" no arrancó: ${f.razon}`);
  }

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
    config, dbh, queue, kv, bus, runtime, dispatcher, sandbox, storage, drivers, plugins,
    conversaciones, automatizaciones,
    shutdown: async () => {
      await plugins.detenerTodos().catch(() => {});
      await Promise.all(workers.map((w) => w.stop().catch(() => {})));
      await runtime.stop();
      await queue.close().catch(() => {});
      await bus.close().catch(() => {});
      await dbh.close().catch(() => {});
    },
  };
}

/**
 * Abre la conversación de un chat con su primer mensaje y anota los siguientes.
 *
 * Vive aquí, y no dentro de la ingesta del motor, porque una conversación es
 * un concepto de atención y no de transporte: el motor no debería saber que
 * existe.
 */
async function anotarConversacion(
  conversaciones: Conversaciones, e: EventEnvelope,
): Promise<void> {
  if (e.event !== "message.received" && e.event !== "message.sent") return;
  const data = e.data as { key?: { remoteJid?: string; fromMe?: boolean } };
  const chat = data.key?.remoteJid;
  if (!chat) return;

  const cuando = new Date(e.timestamp);
  const conv = await conversaciones.abrirOEncontrar(e.orgId, e.lineId, chat, cuando);
  await conversaciones.anotarMensaje(conv.id, cuando, data.key?.fromMe === true);
}
