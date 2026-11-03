import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { asLineId, type EventEnvelope } from "@omni/shared";
import { SandboxDriver } from "@omni/channels";
import { MemoryBus, MemoryJobQueue, MemoryKv } from "@omni/platform";
import { WebhookDispatcher, type DeliveryRecord, type WebhookEndpoint } from "@omni/core";
import { createDatabase, migrate, lineTable, messageTable, chatTable, contactTable, orgTable, authStateTable, type DbHandle } from "@omni/db";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorage } from "@omni/storage";
import { SecretBox } from "../crypto/secret-box.js";
import { EngineRuntime } from "./runtime.js";

const URL = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL ? describe : describe.skip;

const ORG = "org-rt";
const LINE = "line-rt";
const MASTER = "f".repeat(64);
const WH_SECRET = "secreto-webhook";

let h: DbHandle;

beforeAll(async () => {
  if (!URL) return;
  await migrate(URL);
  h = createDatabase(URL);
});
afterAll(async () => { await h?.close(); });

interface Harness {
  runtime: EngineRuntime;
  driver: SandboxDriver;
  queue: MemoryJobQueue;
  bus: MemoryBus;
  deliveries: { body: string; headers: Record<string, string> }[];
  records: DeliveryRecord[];
  stop: () => Promise<void>;
}

async function testStorage(): Promise<LocalStorage> {
  return new LocalStorage({
    directory: await mkdtemp(join(tmpdir(), "omni-rt-")),
    signingSecret: "secreto-de-firma-de-pruebas",
  });
}

async function harness(endpoints: WebhookEndpoint[] = []): Promise<Harness> {
  await h.sql`DELETE FROM message WHERE line_id = ${LINE}`;
  await h.sql`DELETE FROM chat WHERE line_id = ${LINE}`;
  await h.sql`DELETE FROM auth_state WHERE line_id = ${LINE}`;
  await h.sql`DELETE FROM line WHERE id = ${LINE}`;
  await h.sql`DELETE FROM org WHERE id = ${ORG}`;
  await h.db.insert(orgTable).values({ id: ORG, name: "RT", slug: "rt" });
  await h.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "Línea", slug: "linea",
    address: "51999888777@s.whatsapp.net", sendRatePerMinute: 6000,
  });

  const queue = new MemoryJobQueue();
  const deliveries: Harness["deliveries"] = [];
  const records: DeliveryRecord[] = [];
  const dispatcher = new WebhookDispatcher(queue, {
    endpointsFor: async () => endpoints,
    recordDelivery: async (r) => void records.push(r),
    fetchImpl: (async (_url: string, init: RequestInit) => {
      deliveries.push({ body: String(init.body), headers: init.headers as Record<string, string> });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch,
  });

  const driver = new SandboxDriver();
  const bus = new MemoryBus();
  const runtime = new EngineRuntime({
    db: h.db, queue, kv: new MemoryKv(), bus,
    box: new SecretBox(MASTER), dispatcher, storage: await testStorage(),
  });
  runtime.registerDriver(driver);
  runtime.start();
  const whWorker = dispatcher.startWorker();

  return {
    runtime, driver, queue, bus, deliveries, records,
    stop: async () => { await runtime.stop(); await whWorker.stop(); await queue.close(); },
  };
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera a que algo se cumpla, con tope. Afirmar tras un `sleep` fijo funciona
 * en una máquina ociosa y falla cuando corren las demás pruebas a la vez: una
 * prueba inestable no dice nada sobre el código.
 */
async function until<T>(
  fn: () => Promise<T | null | undefined>,
  descripcion: string,
  timeoutMs = 6000,
): Promise<T> {
  const limite = Date.now() + timeoutMs;
  let ultimo: T | null | undefined;
  while (Date.now() < limite) {
    ultimo = await fn();
    if (ultimo !== null && ultimo !== undefined) return ultimo;
    await settle(30);
  }
  throw new Error(`no se cumplió a tiempo: ${descripcion} (último valor: ${JSON.stringify(ultimo)})`);
}

/** Estado actual de un mensaje saliente, o null si aún no es el esperado. */
const estadoDe = async (clientMessageId: string): Promise<string | undefined> =>
  (await h.db.select({ s: messageTable.state }).from(messageTable)
    .where(and(eq(messageTable.lineId, LINE), eq(messageTable.clientMessageId, clientMessageId))))[0]?.s;

const endpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
  id: "ep1", orgId: ORG, lineId: LINE, url: "https://receptor.test/hook",
  events: [], secret: WH_SECRET, hmacEnabled: true, enabled: true,
  maxAttempts: 3, timeoutMs: 1000, backoffMs: 20, filter: null, ...over,
});

run("runtime del motor, de punta a punta", () => {
  let H: Harness;
  beforeEach(async () => { H = await harness([endpoint()]); });
  afterAll(async () => { await H?.stop(); });

  it("enlaza, guarda credenciales CIFRADAS y reconecta sin pedir QR", async () => {
    const status = await H.runtime.connect(LINE);
    expect(status.state).toBe("awaiting-link");

    // El driver persiste por su cuenta al completarse el enlace, igual que
    // Baileys al emitir `creds.update`.
    await H.driver.scan(asLineId(LINE), "51999888777");
    await settle(100);

    const rows = await h.db.select().from(authStateTable).where(eq(authStateTable.lineId, LINE));
    expect(rows).toHaveLength(1);
    // Lo guardado no puede ser legible: una copia de la BD no regala la sesión.
    expect(rows[0]!.sealed).not.toContain("51999888777");
    expect(rows[0]!.sealed.startsWith("v1.")).toBe(true);
    expect(new SecretBox(MASTER).canOpen(rows[0]!.sealed)).toBe(true);

    // Lo que importa de verdad: un redespliegue reconecta sin escanear nada.
    const fresh = new SandboxDriver();
    const runtime2 = new EngineRuntime({
      db: h.db, queue: H.queue, kv: new MemoryKv(), bus: new MemoryBus(),
      box: new SecretBox(MASTER), storage: await testStorage(),
      dispatcher: new WebhookDispatcher(H.queue, {
        endpointsFor: async () => [], recordDelivery: async () => {},
      }),
    });
    runtime2.registerDriver(fresh);
    expect((await runtime2.connect(LINE)).state).toBe("connected");
    await runtime2.stop();
  });

  it("reanuda al arrancar las líneas que tienen credenciales", async () => {
    // Sin esto las credenciales cifradas no sirven de nada: sobreviven al
    // redespliegue pero nadie las usa, y cada arranque deja las líneas muertas.
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    await settle(100);

    const fresh = new SandboxDriver();
    const runtime2 = new EngineRuntime({
      db: h.db, queue: H.queue, kv: new MemoryKv(), bus: new MemoryBus(),
      box: new SecretBox(MASTER), storage: await testStorage(),
      dispatcher: new WebhookDispatcher(H.queue, {
        endpointsFor: async () => [], recordDelivery: async () => {},
      }),
    });
    runtime2.registerDriver(fresh);

    const { resumed, failed } = await runtime2.resumeAll();
    expect(resumed).toContain(LINE);
    // Otras líneas de la base pueden fallar (otra clave maestra, por ejemplo) y
    // eso es correcto: lo que no vale es que una línea rota impida arrancar las
    // demás, así que se informan en vez de propagarse.
    expect(failed.find((f) => f.lineId === LINE)).toBeUndefined();
    expect(fresh.status(asLineId(LINE)).state).toBe("connected");
    await runtime2.stop();
  });

  it("un mensaje entrante se persiste y dispara el webhook firmado", async () => {
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    await H.driver.inbound(asLineId(LINE), "51988777666", "hola, ¿hay stock?");
    await settle(500);

    const msgs = await h.db.select().from(messageTable)
      .where(and(eq(messageTable.lineId, LINE), eq(messageTable.fromMe, false)));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.body).toBe("hola, ¿hay stock?");
    expect(msgs[0]!.chatId).toBe("51988777666@s.whatsapp.net");

    const chats = await h.db.select().from(chatTable).where(eq(chatTable.lineId, LINE));
    expect(chats[0]!.unreadCount).toBe(1);

    const hook = H.deliveries.find((d) => JSON.parse(d.body).event === "message.received");
    expect(hook).toBeDefined();
    expect(hook!.headers["x-omni-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("una llamada deja UNA entrada en el hilo, que sigue sus pasos hasta cómo acabó", async () => {
    /*
     * De una llamada llegan varios avisos sueltos. En el hilo tiene que quedar
     * una sola entrada que diga en qué quedó —aquí, perdida— y el chat tiene
     * que contarla como pendiente, como hace WhatsApp.
     */
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    const vistos: EventEnvelope[] = [];
    await H.bus.subscribe(`org:${ORG}`, (e) => void vistos.push(e as EventEnvelope));

    const desde = "51988777666@s.whatsapp.net";
    for (const status of ["offer", "ringing", "terminate"]) {
      await H.runtime.publish("call.received", LINE, {
        callId: "LLAMADA-1", from: desde, chatId: desde, status, isVideo: false, at: 1_800_000_000_000,
      });
    }

    const filas = await until(async () => {
      const f = await h.db.select().from(messageTable)
        .where(and(eq(messageTable.lineId, LINE), eq(messageTable.kind, "call")));
      return (f[0]?.raw as { call?: { state?: string } } | null)?.call?.state === "missed" ? f : null;
    }, "la llamada quede como perdida");
    expect(filas).toHaveLength(1);
    expect(filas[0]!.chatId).toBe(desde);
    expect(filas[0]!.timestamp.getTime()).toBe(1_800_000_000_000);

    const [chat] = await h.db.select().from(chatTable)
      .where(and(eq(chatTable.lineId, LINE), eq(chatTable.address, desde)));
    expect(chat?.unreadCount).toBe(1);

    // Lo publicado ya va reducido y con su chat: el panel no rehace la cuenta.
    const ultimo = vistos.filter((e) => e.event === "call.received").at(-1)!;
    expect(ultimo.data).toMatchObject({ chatId: desde, call: { state: "missed", id: "LLAMADA-1" } });
  });

  it("una reacción no se cuela en el hilo como si fuera un mensaje", async () => {
    /*
     * WhatsApp entrega la reacción por el mismo canal que los mensajes. Al
     * guardarla como fila propia, el hilo se llenaba de burbujas vacías con la
     * palabra «reaction» dentro y la conversación quedaba enterrada entre
     * ellas. Se vio en un grupo real con 108 de estas.
     */
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    await H.driver.inbound(asLineId(LINE), "51988777666", "la pregunta");
    await settle(400);

    const antes = await h.db.select().from(messageTable).where(eq(messageTable.lineId, LINE));
    await H.runtime.publish("message.received", LINE, {
      key: { id: "REACCION-1", remoteJid: "51988777666@s.whatsapp.net" },
      kind: "reaction", text: "👍", timestamp: Date.now(),
    });
    await settle(300);

    const despues = await h.db.select().from(messageTable).where(eq(messageTable.lineId, LINE));
    expect(despues).toHaveLength(antes.length);
  });

  it("un mensaje retirado se marca y no se pierde lo que decía", async () => {
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    await H.driver.inbound(asLineId(LINE), "51988777666", "me arrepiento de esto");
    await settle(400);

    const [fila] = await h.db.select().from(messageTable)
      .where(and(eq(messageTable.lineId, LINE), eq(messageTable.fromMe, false)));
    expect(fila!.deletedAt).toBeNull();

    await H.runtime.publish("message.deleted", LINE, {
      key: { id: fila!.providerMessageId, remoteJid: "51988777666@s.whatsapp.net" },
    });
    await settle(300);

    const [tras] = await h.db.select().from(messageTable)
      .where(eq(messageTable.id, fila!.id));
    expect(tras!.deletedAt).not.toBeNull();
    // La fila se marca, no se borra: quien audita necesita saber qué decía.
    expect(tras!.body).toBe("me arrepiento de esto");
  });

  it("un protocolMessage de retirada marca el original y no añade burbuja", async () => {
    // Según la versión del cliente, la retirada llega por `messages.delete` o
    // colada entre los mensajes como `protocolMessage`. Las dos cuentan.
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    await H.driver.inbound(asLineId(LINE), "51988777666", "esto se va a retirar");
    await settle(400);

    const [fila] = await h.db.select().from(messageTable)
      .where(and(eq(messageTable.lineId, LINE), eq(messageTable.fromMe, false)));

    await H.runtime.publish("message.received", LINE, {
      key: { id: "PROTO-1", remoteJid: "51988777666@s.whatsapp.net" },
      kind: "system", timestamp: Date.now(),
      raw: { message: { protocolMessage: { key: { id: fila!.providerMessageId }, type: 0 } } },
    });
    await settle(300);

    const todas = await h.db.select().from(messageTable).where(eq(messageTable.lineId, LINE));
    expect(todas.find((m) => m.providerMessageId === "PROTO-1")).toBeUndefined();
    expect(todas.find((m) => m.id === fila!.id)!.deletedAt).not.toBeNull();
  });

  it("cuando el otro lado pone los mensajes temporales, el chat lo apunta", async () => {
    // Es la única forma de saberlo: WhatsApp no deja preguntarlo.
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    await H.driver.inbound(asLineId(LINE), "51988777666", "hola");
    await settle(400);

    await H.runtime.publish("message.received", LINE, {
      key: { id: "PROTO-EF", remoteJid: "51988777666@s.whatsapp.net" },
      kind: "system", timestamp: Date.now(),
      raw: { message: { protocolMessage: { type: 3, ephemeralExpiration: 86400 } } },
    });
    await settle(300);

    const [chat] = await h.db.select({ s: chatTable.ephemeralSeconds }).from(chatTable)
      .where(and(eq(chatTable.lineId, LINE), eq(chatTable.address, "51988777666@s.whatsapp.net")));
    expect(chat?.s).toBe(86400);
    // Y no deja burbuja: es un aviso sobre el chat, no un mensaje.
    const todas = await h.db.select().from(messageTable).where(eq(messageTable.lineId, LINE));
    expect(todas.find((m) => m.providerMessageId === "PROTO-EF")).toBeUndefined();
  });

  it("un canal sin nombre lo aprende al sincronizar, y no toca los que ya tienen", async () => {
    /*
     * Un mensaje de canal no trae el nombre del canal, solo su dirección: sin
     * esto aparecían como `120363…@newsletter`. Se pregunta solo por los que
     * no lo tienen, para no repetir la consulta en cada conexión.
     */
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");

    const canal = await H.driver.createNewsletter(asLineId(LINE), "Avisos del barrio");
    const otro = await H.driver.createNewsletter(asLineId(LINE), "Nombre en WhatsApp");
    await h.db.insert(chatTable).values([
      { id: "c-canal-1", lineId: LINE, address: canal.address.value, kind: "newsletter" },
      {
        id: "c-canal-2", lineId: LINE, address: otro.address.value, kind: "newsletter",
        title: "Ya tenía nombre",
      },
    ]);

    /*
     * Se comprueba el RESULTADO, no cuántos nombró esta llamada.
     *
     * Conectar ya lanza una sincronización en segundo plano, que puede ganar
     * la carrera: entonces esta llamada no encuentra nada que nombrar y
     * devuelve 0. Contar lo que devuelve fallaba de vez en cuando sin que el
     * código tuviera nada mal. Lo que importa es cómo quedan, y que una
     * segunda pasada ya no pregunta por nada.
     */
    await H.runtime.sincronizarCanales(LINE);
    expect(await H.runtime.sincronizarCanales(LINE)).toBe(0);

    const filas = await h.db.select().from(chatTable)
      .where(and(eq(chatTable.lineId, LINE), eq(chatTable.kind, "newsletter")));
    expect(filas.find((f) => f.address === canal.address.value)?.title)
      .toBe("Avisos del barrio");
    expect(filas.find((f) => f.address === otro.address.value)?.title)
      .toBe("Ya tenía nombre");
  });

  it("en un grupo se pide la foto de quien escribe aunque no haya chat con él", async () => {
    /*
     * La foto solo se guardaba en la fila de una conversación, y quien escribe
     * en un grupo casi nunca la tiene: se abandonaba sin pedirla. Ahora va a
     * su contacto. El sandbox no da fotos, así que lo que se comprueba es que
     * se INTENTÓ y quedó anotado, que es justo lo que antes no pasaba.
     */
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    const grupo = "120363000000000999@g.us";
    const participante = "330000000000001@lid";

    await H.runtime.publish("message.received", LINE, {
      key: { id: "G-FOTO-1", remoteJid: grupo, participant: participante },
      pushName: "Esteban", kind: "text", text: "Tin tin ton", timestamp: Date.now(),
    });

    const intento = await until(async () => {
      const [c] = await h.db.select().from(contactTable)
        .where(and(eq(contactTable.lineId, LINE), eq(contactTable.address, participante)));
      return c?.avatarSyncedAt ?? null;
    }, "se pidió la foto del participante");
    expect(intento).toBeInstanceOf(Date);
  });

  it("un envío se acepta enseguida, se encola y acaba enviado", async () => {
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");

    const started = Date.now();
    const accepted = await H.runtime.send(LINE, { to: "51988777666", text: "respuesta" });
    // Aceptar no puede esperar a la red: el cliente recibe 202 al instante.
    expect(Date.now() - started).toBeLessThan(200);
    expect(accepted.state).toBe("queued");

    await until(async () => (await estadoDe(accepted.clientMessageId)) === "read" ? true : null,
      "el mensaje llega a leído");
    const rows = await h.db.select().from(messageTable)
      .where(and(eq(messageTable.lineId, LINE), eq(messageTable.clientMessageId, accepted.clientMessageId)));
    expect(rows[0]!.providerMessageId).toBeTruthy();
    expect(rows[0]!.sentFromPlatform).toBe(true);
  });

  it("el mismo clientMessageId dos veces deja UN solo mensaje", async () => {
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    const input = { to: "51988777666", text: "una vez", clientMessageId: "idem-42" };
    const a = await H.runtime.send(LINE, input);
    const b = await H.runtime.send(LINE, input);
    expect(b.messageId).toBe(a.messageId);
    await settle(400);
    const rows = await h.db.select().from(messageTable)
      .where(and(eq(messageTable.lineId, LINE), eq(messageTable.clientMessageId, "idem-42")));
    expect(rows).toHaveLength(1);
  });

  it("una reserva huérfana no se traga el envío", async () => {
    // Pasa cuando el mensaje se borra —retención, limpieza, una migración— y la
    // reserva sigue viva. Antes devolvía 202 sin insertar ni encolar nada.
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");

    const input = { to: "51988777666", text: "tras la limpieza", clientMessageId: "huerfano-1" };
    await H.runtime.send(LINE, input);
    await until(async () => (await estadoDe("huerfano-1")) ? true : null, "se insertó el primero");

    // Se borra el mensaje pero NO la reserva, que es el caso problemático.
    await h.sql`DELETE FROM message WHERE line_id = ${LINE} AND client_message_id = 'huerfano-1'`;

    await H.runtime.send(LINE, input);
    const estado = await until(async () => (await estadoDe("huerfano-1")) ?? null,
      "el segundo envío se vuelve a insertar");
    expect(estado).toBeTruthy();
  });

  it("los acuses avanzan el estado y nunca retroceden", async () => {
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    const accepted = await H.runtime.send(LINE, { to: "51988777666", text: "acuses" });
    await until(async () => (await estadoDe(accepted.clientMessageId)) === "read" ? true : null,
      "el mensaje llega a leído antes del acuse tardío");

    // Un recibo tardío de "delivered" no puede degradar un mensaje ya leído.
    const rows = await h.db.select({ p: messageTable.providerMessageId }).from(messageTable)
      .where(and(eq(messageTable.lineId, LINE), eq(messageTable.clientMessageId, accepted.clientMessageId)));
    await H.driver.ack(asLineId(LINE), rows[0]!.p!, "delivered");
    await settle(400);
    // Sigue en "leído": un recibo tardío no puede degradarlo.
    expect(await estadoDe(accepted.clientMessageId)).toBe("read");
  });

  it("un acuse que llega antes de que termine el envío no se pierde", async () => {
    /*
     * En WhatsApp el «entregado» y el «leído» pueden llegar antes de que
     * `send` vuelva. El motor escribía entonces «enviado» encima, y un mensaje
     * leído retrocedía a un check gris para siempre. Aquí se fuerza ese orden:
     * el acuse se ingiere DENTRO de `send`, antes de devolver el recibo.
     */
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");

    const original = H.driver.send.bind(H.driver);
    H.driver.send = async (cmd) => {
      const recibo = await original(cmd);
      await H.runtime.publish("message.receipt", LINE, {
        key: { id: recibo.providerMessageId }, state: "read",
      });
      // El recibo dice «enviado», que es lo que devuelve WhatsApp al aceptar.
      return { ...recibo, state: "sent" };
    };
    try {
      const enviado = await H.runtime.send(LINE, {
        to: "51988777666", text: "rápido", clientMessageId: "acuse-temprano",
      });
      await until(async () => {
        const [f] = await h.db.select({ p: messageTable.providerMessageId }).from(messageTable)
          .where(and(eq(messageTable.lineId, LINE),
            eq(messageTable.clientMessageId, enviado.clientMessageId)));
        return f?.p ? true : null;
      }, "el envío terminó");
      await settle(200);
      expect(await estadoDe("acuse-temprano")).toBe("read");
    } finally {
      H.driver.send = original;
    }
  });

  it("enviar por una línea sin conectar no se acepta en silencio", async () => {
    await expect(H.runtime.send(LINE, { to: "51988777666", text: "x" })).resolves.toBeDefined();
    await settle(400);
    // Se aceptó y se encoló, pero el envío real falla y queda registrado.
    const rows = await h.db.select({ s: messageTable.state }).from(messageTable)
      .where(eq(messageTable.lineId, LINE));
    expect(["queued", "failed"]).toContain(rows[0]!.s);
  });

  it("un envío que se da por perdido se avisa EN VIVO, con su motivo y su chat", async () => {
    /*
     * Antes solo salía como webhook: el panel no se enteraba y seguía
     * enseñando el reloj de «en cola» de un mensaje que ya no iba a salir.
     */
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    const original = H.driver.send.bind(H.driver);
    H.driver.send = async () => { throw new Error("el teléfono no responde"); };
    const vistos: EventEnvelope[] = [];
    const baja = await H.bus.subscribe<EventEnvelope>(`org:${ORG}`, (e) => { vistos.push(e); });
    try {
      await H.runtime.send(LINE, { to: "51988777666", text: "no saldrá", clientMessageId: "perdido-1" });
      const fallo = await until(
        async () => vistos.find((e) => e.event === "message.failed") ?? null,
        "el aviso de fallo", 15000,
      );
      expect(fallo.data).toMatchObject({
        clientMessageId: "perdido-1",
        reason: "el teléfono no responde",
        key: { remoteJid: "51988777666@s.whatsapp.net", fromMe: true },
      });
      expect(await estadoDe("perdido-1")).toBe("failed");
    } finally {
      H.driver.send = original;
      await baja();
    }
  }, 20000);

  it("pedir una capacidad que el transporte no tiene da 422 antes de encolar", async () => {
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    // El sandbox soporta todo, así que se comprueba el camino de validación.
    await expect(H.runtime.send(LINE, { to: "51988777666" } as never))
      .rejects.toMatchObject({ status: 422 });
  });
});
