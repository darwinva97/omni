import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { BaileysDriver, createFakeSocket, type FakeSocketControl } from "@omni/channels";
import { MemoryKv, PostgresBus, PostgresJobQueue, ensurePlatformSchema } from "@omni/platform";
import { WebhookDispatcher, type WebhookEndpoint } from "@omni/core";
import {
  createDatabase, migrate, contactTable, identityMapTable, lineTable, messageTable, orgTable,
  type DbHandle,
} from "@omni/db";
import { LocalStorage } from "@omni/storage";
import { SecretBox } from "../crypto/secret-box.js";
import { EngineRuntime } from "./runtime.js";

/*
 * La sincronización del historial al enlazar una línea de WhatsApp.
 *
 * WhatsApp vuelca de golpe miles de chats, contactos y parejas LID ↔ teléfono.
 * Todo eso se ingiere en el MISMO proceso que atiende HTTP, porque es quien
 * tiene el socket. Lo que se comprueba aquí es lo que se rompió en producción:
 * que mientras dura el volcado el proceso siga respondiendo —el event loop sin
 * bloqueos largos y la base sin una cola de miles de consultas delante de la
 * sonda de salud— y que, aun así, todo se guarde y se guarde una sola vez.
 */

const URL = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL ? describe : describe.skip;

const ORG = "org-hist";
const LINE = "line-hist";
const PROPIA = "51900000000:1@s.whatsapp.net";
const ENDPOINT = "ep-hist";

/*
 * Cada contacto del volcado deja un webhook encolado en la cola REAL de
 * Postgres, y aquí no hay trabajador que los entregue. Quedarse ahí haría que
 * el trabajador de las pruebas de la API —misma base— se pasara minutos
 * reclamando miles de entregas ajenas.
 */
const borrarEntregas = async (): Promise<void> => {
  if (!h) return;
  await h.sql`DELETE FROM omni_job WHERE partition_key = ${`wh:${ENDPOINT}`}`;
};

/** Tamaño del volcado: del orden de lo que manda una cuenta real con uso. */
const CHATS = 3000;
const MENSAJES_POR_CHAT = 10;

/*
 * Umbrales, holgados a propósito: es una prueba de punta a punta con Postgres
 * en una máquina de CI compartida, donde un proceso EN REPOSO ya ve picos de
 * cien milisegundos. Lo que separan es el antes y el después: antes de los
 * lotes, este mismo volcado bloqueaba el hilo más de cuatro segundos seguidos
 * y la sonda esperaba más de diez. El tope fino, por lote, lo fija la prueba
 * del driver, que no depende de la máquina.
 */
const MAX_BLOQUEO_MS = 1000;
const MAX_SONDA_MS = 2000;

/**
 * Mide el tramo más largo que el hilo pasó sin soltar el event loop.
 *
 * Un temporizador que salta cada 5 ms anota, entre salto y salto, cuánto
 * tiempo de CPU gastó ESTE hilo. El retardo de reloj a secas no vale en una
 * máquina compartida: allí un proceso en reposo ya ve huecos de cien
 * milisegundos porque el sistema no le da la CPU, y eso no es bloquear. Si
 * el hilo no tuvo CPU, no estaba bloqueando; si la tuvo todo el hueco, sí.
 */
function medirBloqueo(): { parar: () => { maxMs: number; maxRelojMs: number } } {
  const cpu = (): number => {
    const u = process.threadCpuUsage();
    return (u.user + u.system) / 1000;
  };
  let reloj = performance.now();
  let gastado = cpu();
  let maxMs = 0;
  let maxRelojMs = 0;
  const t = setInterval(() => {
    const ahora = performance.now();
    const ahoraCpu = cpu();
    const hueco = ahora - reloj;
    maxRelojMs = Math.max(maxRelojMs, hueco);
    maxMs = Math.max(maxMs, Math.min(hueco, ahoraCpu - gastado));
    reloj = ahora;
    gastado = ahoraCpu;
  }, 5);
  return { parar: () => { clearInterval(t); return { maxMs, maxRelojMs }; } };
}

let h: DbHandle;
let bus: DbHandle;

beforeAll(async () => {
  if (!URL) return;
  await migrate(URL);
  h = createDatabase(URL);
  bus = createDatabase(URL, { max: 2 });
  await ensurePlatformSchema(h.sql);
});
afterAll(async () => {
  await bus?.close();
  await h?.close();
});

const pn = (i: number): string => `5198${String(i).padStart(7, "0")}@s.whatsapp.net`;
const lid = (i: number): string => `${7000000 + i}@lid`;

/** Un volcado como el que arma Baileys a partir de la notificación de historial. */
function volcado(desde: number, hasta: number): Record<string, unknown> {
  const chats = [];
  const contacts = [];
  const messages = [];
  const lidPnMappings = [];
  for (let c = desde; c < hasta; c++) {
    chats.push({ id: pn(c), name: `Contacto ${c}` });
    contacts.push({ id: pn(c), name: `Contacto ${c}`, lid: lid(c), phoneNumber: pn(c) });
    // Baileys anuncia la misma pareja por dos sitios: viene repetida a propósito.
    lidPnMappings.push({ lid: lid(c), pn: pn(c) }, { lid: lid(c), pn: pn(c) });
    for (let m = 0; m < MENSAJES_POR_CHAT; m++) {
      messages.push({
        key: { remoteJid: pn(c), fromMe: m % 2 === 0, id: `H${c}-${m}` },
        messageTimestamp: 1_700_000_000 + m,
        message: { conversation: `mensaje viejo ${m} del chat ${c}` },
        pushName: `Contacto ${c}`,
      });
    }
  }
  return { chats, contacts, messages, lidPnMappings, syncType: 2, progress: 100, isLatest: true };
}

async function contar(): Promise<{ contactos: number; parejas: number }> {
  const [c] = await h.db.select({ n: sql<number>`count(*)::int` }).from(contactTable)
    .where(eq(contactTable.lineId, LINE));
  const [p] = await h.db.select({ n: sql<number>`count(*)::int` }).from(identityMapTable)
    .where(eq(identityMapTable.lineId, LINE));
  return { contactos: c?.n ?? 0, parejas: p?.n ?? 0 };
}

run("historial de WhatsApp sin bloquear el proceso", () => {
  let runtime: EngineRuntime;
  let fake: FakeSocketControl;
  let queue: PostgresJobQueue;

  beforeAll(async () => {
    // `message` y `chat` no cuelgan de la línea con borrado en cascada.
    await h.sql`DELETE FROM message WHERE line_id = ${LINE}`;
    await borrarEntregas();
    await h.sql`DELETE FROM chat WHERE line_id = ${LINE}`;
    await h.sql`DELETE FROM line WHERE id = ${LINE}`;
    await h.sql`DELETE FROM org WHERE id = ${ORG}`;
    await h.db.insert(orgTable).values({ id: ORG, name: "Historial", slug: "historial" });
    await h.db.insert(lineTable).values({
      id: LINE, orgId: ORG, channelKind: "whatsapp.baileys", name: "Línea", slug: "linea-hist",
    });

    queue = new PostgresJobQueue(h.sql);
    // Un receptor suscrito a TODO, como el de cualquier integración.
    const endpoint: WebhookEndpoint = {
      id: ENDPOINT, orgId: ORG, lineId: LINE, url: "https://receptor.test/hook",
      events: [], secret: "s", hmacEnabled: false, enabled: true,
      maxAttempts: 1, timeoutMs: 1000, filter: null,
    };
    const dispatcher = new WebhookDispatcher(queue, {
      endpointsFor: async () => [endpoint],
      recordDelivery: async () => {},
    });

    fake = createFakeSocket({ id: PROPIA, name: "Yo" });
    const driver = new BaileysDriver({
      makeSocket: () => fake.socket,
      fetchVersion: (async () => ({ version: [2, 3000, 1] })) as never,
      linkWaitMs: 0,
    });

    runtime = new EngineRuntime({
      db: h.db, queue, kv: new MemoryKv(), bus: new PostgresBus(bus.sql),
      box: new SecretBox("e".repeat(64)), dispatcher,
      storage: new LocalStorage({
        directory: await mkdtemp(join(tmpdir(), "omni-hist-")), signingSecret: "firma-de-pruebas",
      }),
    });
    runtime.registerDriver(driver);
    await runtime.connect(LINE);
    fake.emitConnection({ connection: "open" });
    await new Promise((r) => setTimeout(r, 100));
  });

  afterAll(async () => {
    await runtime?.stop();
    await queue?.close();
    await borrarEntregas();
  });

  it("ingiere miles de chats sin bloquear, sin perder ni duplicar nada", async () => {
    /*
     * La sonda hace lo mismo que `/health`: una consulta por el MISMO pool que
     * usa la ingesta. Si el volcado acapara las conexiones, la sonda espera
     * detrás de miles de consultas aunque el event loop esté libre.
     */
    let sondaMax = 0;
    let sondando = true;
    const sonda = (async () => {
      while (sondando) {
        const t = performance.now();
        await h.sql`SELECT 1`;
        sondaMax = Math.max(sondaMax, performance.now() - t);
        await new Promise((r) => setTimeout(r, 50));
      }
    })();

    // Dos trozos, como los sucesivos de un volcado real, y el segundo solapado
    // con el primero: repite chats a propósito. Se arman ANTES de medir: lo
    // que se mide es la ingesta, no la prueba.
    const trozos = [volcado(0, CHATS / 2), volcado(CHATS / 4, CHATS)];

    const bloqueo = medirBloqueo();
    const t0 = performance.now();
    for (const trozo of trozos) fake.emitRaw("messaging-history.set", trozo);

    // Un mensaje nuevo que llega EN MEDIO del volcado no puede quedarse atrás.
    fake.emitRaw("messages.upsert", {
      type: "notify",
      messages: [{
        key: { remoteJid: pn(1), fromMe: false, id: "NUEVO-1" },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: "hola, ¿siguen ahí?" },
        pushName: "Contacto 1",
      }],
    });

    const limite = Date.now() + 120_000;
    let ultimo = await contar();
    while ((ultimo.contactos < CHATS || ultimo.parejas < CHATS) && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 100));
      ultimo = await contar();
    }
    const duracion = performance.now() - t0;
    const { maxMs: maxBloqueo, maxRelojMs } = bloqueo.parar();
    sondando = false;
    await sonda;

    console.info(
      `historial: ${CHATS} chats en ${duracion.toFixed(0)} ms; ` +
      `bloqueo máximo ${maxBloqueo.toFixed(0)} ms de CPU (${maxRelojMs.toFixed(0)} ms de reloj); ` +
      `sonda de salud máxima ${sondaMax.toFixed(0)} ms`,
    );

    // Todo, una sola vez: una fila por contacto y una por pareja.
    expect(ultimo).toEqual({ contactos: CHATS, parejas: CHATS });
    const [muestra] = await h.db.select().from(contactTable)
      .where(and(eq(contactTable.lineId, LINE), eq(contactTable.address, pn(CHATS - 1))));
    expect(muestra?.savedName).toBe(`Contacto ${CHATS - 1}`);

    // El historial no se convierte en mensajes; el mensaje nuevo sí, una vez.
    const mensajes = await h.db.select({ id: messageTable.providerMessageId }).from(messageTable)
      .where(eq(messageTable.lineId, LINE));
    expect(mensajes.map((m) => m.id)).toEqual(["NUEVO-1"]);

    expect(maxBloqueo).toBeLessThan(MAX_BLOQUEO_MS);
    expect(sondaMax).toBeLessThan(MAX_SONDA_MS);
  }, 180_000);
});
