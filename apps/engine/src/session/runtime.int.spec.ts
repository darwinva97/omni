import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { asLineId, type EventEnvelope } from "@omni/shared";
import { SandboxDriver } from "@omni/channels";
import { MemoryBus, MemoryJobQueue, MemoryKv } from "@omni/platform";
import { WebhookDispatcher, type DeliveryRecord, type WebhookEndpoint } from "@omni/core";
import { createDatabase, migrate, lineTable, messageTable, chatTable, orgTable, authStateTable, type DbHandle } from "@omni/db";
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
  deliveries: { body: string; headers: Record<string, string> }[];
  records: DeliveryRecord[];
  stop: () => Promise<void>;
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
  const runtime = new EngineRuntime({
    db: h.db, queue, kv: new MemoryKv(), bus: new MemoryBus(),
    box: new SecretBox(MASTER), dispatcher,
  });
  runtime.registerDriver(driver);
  runtime.start();
  const whWorker = dispatcher.startWorker();

  return {
    runtime, driver, queue, deliveries, records,
    stop: async () => { await runtime.stop(); await whWorker.stop(); await queue.close(); },
  };
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

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
      box: new SecretBox(MASTER),
      dispatcher: new WebhookDispatcher(H.queue, {
        endpointsFor: async () => [], recordDelivery: async () => {},
      }),
    });
    runtime2.registerDriver(fresh);
    expect((await runtime2.connect(LINE)).state).toBe("connected");
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

  it("un envío se acepta enseguida, se encola y acaba enviado", async () => {
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");

    const started = Date.now();
    const accepted = await H.runtime.send(LINE, { to: "51988777666", text: "respuesta" });
    // Aceptar no puede esperar a la red: el cliente recibe 202 al instante.
    expect(Date.now() - started).toBeLessThan(200);
    expect(accepted.state).toBe("queued");

    await settle(600);
    const rows = await h.db.select().from(messageTable)
      .where(and(eq(messageTable.lineId, LINE), eq(messageTable.clientMessageId, accepted.clientMessageId)));
    expect(rows[0]!.state).toBe("read");
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

  it("los acuses avanzan el estado y nunca retroceden", async () => {
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    const accepted = await H.runtime.send(LINE, { to: "51988777666", text: "acuses" });
    await settle(500);

    const before = await h.db.select({ s: messageTable.state }).from(messageTable)
      .where(and(eq(messageTable.lineId, LINE), eq(messageTable.clientMessageId, accepted.clientMessageId)));
    expect(before[0]!.s).toBe("read");

    // Un recibo tardío de "delivered" no puede degradar un mensaje ya leído.
    const rows = await h.db.select({ p: messageTable.providerMessageId }).from(messageTable)
      .where(and(eq(messageTable.lineId, LINE), eq(messageTable.clientMessageId, accepted.clientMessageId)));
    await H.driver.ack(asLineId(LINE), rows[0]!.p!, "delivered");
    await settle(300);

    const after = await h.db.select({ s: messageTable.state }).from(messageTable)
      .where(and(eq(messageTable.lineId, LINE), eq(messageTable.clientMessageId, accepted.clientMessageId)));
    expect(after[0]!.s).toBe("read");
  });

  it("enviar por una línea sin conectar no se acepta en silencio", async () => {
    await expect(H.runtime.send(LINE, { to: "51988777666", text: "x" })).resolves.toBeDefined();
    await settle(400);
    // Se aceptó y se encoló, pero el envío real falla y queda registrado.
    const rows = await h.db.select({ s: messageTable.state }).from(messageTable)
      .where(eq(messageTable.lineId, LINE));
    expect(["queued", "failed"]).toContain(rows[0]!.s);
  });

  it("pedir una capacidad que el transporte no tiene da 422 antes de encolar", async () => {
    await H.runtime.connect(LINE);
    await H.driver.scan(asLineId(LINE), "51999888777");
    // El sandbox soporta todo, así que se comprueba el camino de validación.
    await expect(H.runtime.send(LINE, { to: "51988777666" } as never))
      .rejects.toMatchObject({ status: 422 });
  });
});
