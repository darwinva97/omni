import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { verifySignature } from "@omni/core";
import { apiKeyTable, createDatabase, lineTable, migrate, orgTable, type DbHandle } from "@omni/db";
import { eq } from "drizzle-orm";
import { loadConfig } from "./config.js";
import { buildContainer, type Container } from "./container.js";
import { createApp } from "./app.js";
import { mintApiKey } from "./keys.js";

const URL = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL ? describe : describe.skip;

const ORG = "org-api";
const LINE = "line-api";
const WH_SECRET = "secreto-de-webhook-suficientemente-largo";

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let adminKey: string;
let scopedKey: string;
const hooks: { body: string; headers: Record<string, string> }[] = [];

beforeAll(async () => {
  if (!URL) return;
  await migrate(URL);
  dbh = createDatabase(URL);
  for (const t of ["webhook_delivery", "webhook_endpoint", "message", "chat", "auth_state", "api_key", "line"]) {
    await dbh.sql.unsafe(`DELETE FROM ${t} WHERE ${t === "line" ? "id" : "line_id"} = '${LINE}'`).catch(() => {});
  }
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM webhook_endpoint WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE id = ${LINE}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.db.insert(orgTable).values({ id: ORG, name: "API", slug: "api" });
  await dbh.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "Línea", slug: "linea",
    address: "51999888777@s.whatsapp.net", sendRatePerMinute: 6000,
  });

  const admin = await mintApiKey();
  adminKey = admin.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-admin", orgId: ORG, name: "admin", prefix: admin.prefix,
    secretHash: admin.secretHash, role: "admin",
  });

  const scoped = await mintApiKey();
  scopedKey = scoped.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-scoped", orgId: ORG, name: "agente acotado", prefix: scoped.prefix,
    secretHash: scoped.secretHash, role: "operator",
    allowedLines: [LINE], allowedChats: ["51988777666@s.whatsapp.net"],
  });

  const config = loadConfig({
    ...process.env,
    DATABASE_URL: URL, OMNI_MASTER_KEY: "e".repeat(64), SANDBOX_ENABLED: "true",
  } as NodeJS.ProcessEnv);

  container = await buildContainer(config, {
    runMigrations: false,
    // Contra el camino REAL de Postgres, no en memoria. Probar solo en memoria
    // dejó pasar un fallo que reventaba todos los envíos en producción.
    inMemoryPlatform: false,
    fetchImpl: (async (_u: string, init: RequestInit) => {
      hooks.push({ body: String(init.body), headers: init.headers as Record<string, string> });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch,
  });
  app = createApp(container);
});

afterAll(async () => {
  await container?.shutdown();
  await dbh?.close();
});

const call = (path: string, init: RequestInit = {}, key = adminKey) =>
  app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...init.headers },
  });

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/** Lee el cuerpo con el tipo que el test espera, en vez de arrastrar `unknown`. */
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

run("API HTTP de punta a punta", () => {
  it("publica salud y capacidades sin credencial", async () => {
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect((await json<{ data: { checks: Record<string, boolean> } }>(health)).data.checks["database"]).toBe(true);

    const caps = await app.request("/v1/capabilities");
    const body = await json<{ data: { kind: string; risk: string; capabilities: string[] }[] }>(caps);
    const sandbox = body.data[0]!;
    expect(sandbox.kind).toBe("sandbox");
    // El perfil de riesgo se publica para que el panel pueda advertir.
    expect(sandbox.risk).toBe("simulated");
    expect(sandbox.capabilities).toContain("send.text");
  });

  it("genera un contrato OpenAPI con el aviso de riesgo por delante", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const spec = await json<{ openapi: string; info: { description: string }; paths: Record<string, unknown> }>(res);
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.description).toMatch(/NO oficiales/);
    expect(Object.keys(spec.paths).length).toBeGreaterThan(8);
  });

  it("rechaza sin credencial y con credencial inválida", async () => {
    expect((await app.request("/v1/lines")).status).toBe(401);
    expect((await call("/v1/lines", {}, "omni_falso_secreto")).status).toBe(401);
  });

  it("recorre el flujo completo: enlazar, recibir, responder", async () => {
    // 1. registrar un receptor de webhooks
    const wh = await call("/v1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://receptor.test/hook", events: [], lineId: LINE, secret: WH_SECRET }),
    });
    expect(wh.status).toBe(201);

    // 2. enlazar la línea: sin teléfono, por API
    const connect = await call(`/v1/lines/${LINE}/connect`, { method: "POST" });
    expect((await json<{ data: { state: string } }>(connect)).data.state).toBe("awaiting-link");

    const scan = await call(`/v1/sandbox/lines/${LINE}/scan`, {
      method: "POST", body: JSON.stringify({ phone: "51999888777" }),
    });
    expect((await json<{ data: { state: string } }>(scan)).data.state).toBe("connected");

    // 3. un contacto que no existe nos escribe
    const inbound = await call(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST",
      body: JSON.stringify({ from: "51988777666", text: "¿tienen stock?" }),
    });
    expect(inbound.status).toBe(201);
    await settle(600);

    // 4. el webhook llegó firmado y verificable
    const hook = hooks.find((h) => JSON.parse(h.body).event === "message.received");
    expect(hook, "el receptor no recibió message.received").toBeDefined();
    const sig = hook!.headers["x-omni-signature"]!;
    expect(verifySignature(hook!.body, sig, WH_SECRET)).toEqual({ ok: true });

    // 5. responder
    const send = await call(`/v1/lines/${LINE}/messages`, {
      method: "POST",
      body: JSON.stringify({ to: "51988777666", text: "sí, quedan tres" }),
    });
    // 202: aceptado y encolado. Decir 200 haría creer que ya se entregó.
    expect(send.status).toBe(202);
    await settle(600);

    // 6. la conversación está completa y en orden
    const chatId = encodeURIComponent("51988777666@s.whatsapp.net");
    const history = await call(`/v1/lines/${LINE}/chats/${chatId}/messages`);
    const msgs = (await json<{ data: { body: string; fromMe: boolean; state: string }[] }>(history)).data;
    expect(msgs.map((m) => m.body)).toEqual(["sí, quedan tres", "¿tienen stock?"]);
    expect(msgs.find((m) => m.fromMe)!.state).toBe("read");
  });

  it("repetir clientMessageId no duplica el mensaje", async () => {
    const payload = JSON.stringify({ to: "51988777666", text: "una vez", clientMessageId: "http-idem-1" });
    const a = await call(`/v1/lines/${LINE}/messages`, { method: "POST", body: payload });
    const b = await call(`/v1/lines/${LINE}/messages`, { method: "POST", body: payload });
    type Aceptado = { data: { messageId: string } };
    expect((await json<Aceptado>(b)).data.messageId).toBe((await json<Aceptado>(a)).data.messageId);
  });

  it("valida el cuerpo y explica el problema en formato RFC 7807", async () => {
    const res = await call(`/v1/lines/${LINE}/messages`, {
      method: "POST", body: JSON.stringify({ to: "51988777666" }),
    });
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const p = await json<{ status: number; type: string }>(res);
    expect(p.status).toBe(422);
    expect(p.type).toContain("/errors/");
  });

  it("una clave acotada a un chat solo alcanza ese chat", async () => {
    const permitido = await call(`/v1/lines/${LINE}/messages`, {
      method: "POST", body: JSON.stringify({ to: "51988777666", text: "dentro del alcance" }),
    }, scopedKey);
    expect(permitido.status).toBe(202);

    const fuera = await call(`/v1/lines/${LINE}/messages`, {
      method: "POST", body: JSON.stringify({ to: "51900000000", text: "fuera del alcance" }),
    }, scopedKey);
    expect(fuera.status).toBe(403);
  });

  it("una clave acotada no puede tocar rutas no marcadas como seguras", async () => {
    // Listar receptores de webhooks no es seguro para una clave de chat.
    expect((await call("/v1/webhooks", {}, scopedKey)).status).toBe(403);
  });

  it("nombrar una línea fuera de alcance da 401, no 403", async () => {
    // Un 403 confirmaría que esa línea existe.
    const res = await call(`/v1/lines/otra-linea/status`, {}, scopedKey);
    expect(res.status).toBe(401);
  });

  it("con los trabajadores fuera, el motor SIGUE enviando", async () => {
    // Repartir los procesos no puede dejar los mensajes en la cola para
    // siempre: el motor es el único que tiene los sockets.
    const aparte = await buildContainer(
      loadConfig({
        ...process.env, DATABASE_URL: URL!, OMNI_MASTER_KEY: "e".repeat(64),
        SANDBOX_ENABLED: "true", RUN_WORKERS_IN_API: "false",
      } as NodeJS.ProcessEnv),
      { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
    );
    const appAparte = createApp(aparte);
    const llamar = (p: string, init: RequestInit = {}) =>
      appAparte.request(p, {
        ...init,
        headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json", ...init.headers },
      });

    await llamar(`/v1/lines/${LINE}/connect`, { method: "POST" });
    await llamar(`/v1/sandbox/lines/${LINE}/scan`, {
      method: "POST", body: JSON.stringify({ phone: "51999888777" }),
    });
    await llamar(`/v1/lines/${LINE}/messages`, {
      method: "POST",
      body: JSON.stringify({ to: "51988777666", text: "sin trabajadores", clientMessageId: "sin-worker-1" }),
    });

    const limite = Date.now() + 6000;
    let estado = "queued";
    while (Date.now() < limite && estado === "queued") {
      await settle(100);
      const filas = await dbh.sql`
        SELECT state FROM message WHERE line_id = ${LINE} AND client_message_id = 'sin-worker-1'`;
      estado = String(filas[0]?.["state"] ?? "queued");
    }
    await aparte.shutdown();
    expect(estado, "el mensaje se quedó encolado sin nadie que lo enviara").not.toBe("queued");
  });

  it("los intentos de entrega quedan consultables", async () => {
    const res = await call("/v1/dispatches");
    const body = await json<{ data: { status: string; durationMs: number }[] }>(res);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]).toHaveProperty("status");
    expect(body.data[0]).toHaveProperty("durationMs");
  });
});
