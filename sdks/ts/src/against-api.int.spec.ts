import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiKeyTable, createDatabase, lineTable, migrate, orgTable, type DbHandle } from "@omni/db";
import { loadConfig } from "../../../apps/api/src/config.js";
import { buildContainer, type Container } from "../../../apps/api/src/container.js";
import { createApp } from "../../../apps/api/src/app.js";
import { mintApiKey } from "../../../apps/api/src/keys.js";
import { OmniApiError, OmniClient, parseWebhook } from "./index.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-sdk";
const LINE = "line-sdk";
const CHAT = "51988777666@s.whatsapp.net";
const WH_SECRET = "secreto-de-webhook-para-el-sdk";

let dbh: DbHandle;
let container: Container;
let sdk: OmniClient;
const entregas: { body: string; headers: Record<string, string> }[] = [];

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  for (const t of ["message", "chat", "auth_state"]) {
    await dbh.sql.unsafe(`DELETE FROM ${t} WHERE line_id = '${LINE}'`).catch(() => {});
  }
  await dbh.sql`DELETE FROM webhook_endpoint WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE id = ${LINE}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.sql`DELETE FROM omni_kv WHERE key LIKE ${'idem:' + LINE + ':%'}`.catch(() => {});
  await dbh.db.insert(orgTable).values({ id: ORG, name: "SDK", slug: "sdk" });
  await dbh.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "L", slug: "l",
    address: "51999888777@s.whatsapp.net", sendRatePerMinute: 6000,
  });
  const k = await mintApiKey();
  await dbh.db.insert(apiKeyTable).values({
    id: "k-sdk", orgId: ORG, name: "sdk", prefix: k.prefix, secretHash: k.secretHash, role: "admin",
  });

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "7".repeat(64),
      SANDBOX_ENABLED: "true", MEDIA_DIR: "./.data/test-media-sdk",
    } as NodeJS.ProcessEnv),
    {
      runMigrations: false,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        entregas.push({ body: String(init.body), headers: init.headers as Record<string, string> });
        return new Response("ok", { status: 200 });
      }) as unknown as typeof fetch,
    },
  );
  const app = createApp(container);

  // El SDK habla con la app real, no con un doble: es lo único que demuestra
  // que cliente y servidor concuerdan de verdad.
  sdk = new OmniClient({
    baseUrl: "http://local.test",
    apiKey: k.plaintext,
    fetchImpl: ((url: string | URL, init?: RequestInit) =>
      app.request(String(url).replace("http://local.test", ""), init)) as unknown as typeof fetch,
  });
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

const hasta = async (cond: () => Promise<boolean>, que: string, ms = 6000): Promise<void> => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no se cumplió: ${que}`);
};

run("el SDK contra la API real", () => {
  it("lista las líneas y consulta capacidades", async () => {
    const lineas = await sdk.listLines();
    expect(lineas.map((l) => l.id)).toContain(LINE);
    expect(await sdk.supports("sandbox", "send.poll")).toBe(true);
  });

  it("recorre el ciclo: webhook, enlace, recibir, responder", async () => {
    const wh = await sdk.createWebhook({
      url: "https://receptor.test/hook", lineId: LINE, secret: WH_SECRET,
    });
    expect(wh.secret).toBe(WH_SECRET);

    await sdk.connectLine(LINE);
    // El escaneo del sandbox no está en el SDK: es una operación de pruebas.
    await container.sandbox!.scan(LINE as never, "51999888777");
    await container.sandbox!.inbound(LINE as never, "51988777666", "hola desde el SDK");

    const aceptado = await sdk.send(LINE, {
      to: "51988777666", text: "respondo desde el SDK", clientMessageId: "sdk-1",
    });
    expect(aceptado.state).toBe("queued");

    await hasta(
      async () => (await sdk.listMessages(LINE, CHAT)).some((m) => m.fromMe && m.state === "read"),
      "el mensaje llega a leído",
    );

    const mensajes = await sdk.listMessages(LINE, CHAT);
    expect(mensajes.map((m) => m.body)).toEqual(["respondo desde el SDK", "hola desde el SDK"]);
  });

  it("el mismo clientMessageId no duplica", async () => {
    const a = await sdk.send(LINE, { to: "51988777666", text: "una vez", clientMessageId: "sdk-idem" });
    const b = await sdk.send(LINE, { to: "51988777666", text: "una vez", clientMessageId: "sdk-idem" });
    expect(b.messageId).toBe(a.messageId);
  });

  it("verifica con su propia función la firma que puso el servidor", async () => {
    // Las dos mitades del contrato de webhooks, comprobadas una contra otra.
    await hasta(async () => entregas.length > 0, "llega alguna entrega");
    const entrega = entregas.find((e) => JSON.parse(e.body).event === "message.received")!;
    expect(entrega).toBeDefined();

    const ev = parseWebhook<{ text: string }>(
      entrega.body, entrega.headers["x-omni-signature"], WH_SECRET,
    );
    expect(ev.event).toBe("message.received");
    expect(ev.lineId).toBe(LINE);
    expect(ev.data.text).toBe("hola desde el SDK");
  });

  it("un error de la API llega desmenuzado, no como texto", async () => {
    const err = await sdk.send(LINE, { to: "51988777666" } as never)
      .then(() => null, (e: unknown) => e as OmniApiError);
    expect(err).toBeInstanceOf(OmniApiError);
    expect(err!.status).toBe(422);
    expect(err!.detail.length).toBeGreaterThan(10);
  });

  it("los intentos de entrega se consultan", async () => {
    const d = await sdk.listDispatches({ limit: 5 });
    expect(d.length).toBeGreaterThan(0);
    expect(d[0]).toHaveProperty("durationMs");
  });
});
