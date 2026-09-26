import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiKeyTable, createDatabase, lineTable, migrate, orgTable, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey } from "../keys.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-compat";
const LINE = "line-compat";
const OTRA = "line-compat-2";

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let claveUnaLinea = "";
let claveDosLineas = "";

const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  for (const t of ["message", "chat", "auth_state"]) {
    for (const l of [LINE, OTRA]) {
      await dbh.sql.unsafe(`DELETE FROM ${t} WHERE line_id = '${l}'`).catch(() => {});
    }
  }
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.sql`DELETE FROM omni_kv WHERE key LIKE ${'idem:' + LINE + ':%'}`.catch(() => {});
  await dbh.db.insert(orgTable).values({ id: ORG, name: "Compat", slug: "compat" });
  await dbh.db.insert(lineTable).values([
    { id: LINE, orgId: ORG, channelKind: "sandbox", name: "Una", slug: "una",
      address: "51999888777@s.whatsapp.net", sendRatePerMinute: 6000 },
    { id: OTRA, orgId: ORG, channelKind: "sandbox", name: "Otra", slug: "otra", sendRatePerMinute: 6000 },
  ]);

  const a = await mintApiKey();
  claveUnaLinea = a.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-compat-1", orgId: ORG, name: "una línea", prefix: a.prefix,
    secretHash: a.secretHash, role: "admin", allowedLines: [LINE],
  });
  const b = await mintApiKey();
  claveDosLineas = b.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-compat-2", orgId: ORG, name: "sin acotar", prefix: b.prefix,
    secretHash: b.secretHash, role: "admin",
  });

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "5".repeat(64),
      SANDBOX_ENABLED: "true", MEDIA_DIR: "./.data/test-media-compat",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);

  const H = { authorization: `Bearer ${claveUnaLinea}`, "content-type": "application/json" };
  await app.request(`/v1/lines/${LINE}/connect`, { method: "POST", headers: H });
  await app.request(`/v1/sandbox/lines/${LINE}/scan`, {
    method: "POST", headers: H, body: JSON.stringify({ phone: "51999888777" }),
  });
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

run("compatibilidad con WasenderAPI", () => {
  const post = (path: string, cuerpo: unknown, clave = claveUnaLinea) =>
    app.request(`/compat/wasender${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${clave}`, "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
    });

  it("envía texto con SU forma de petición y SU sobre de respuesta", async () => {
    const res = await post("/api/send-message", { to: "51988777666", text: "desde wasender" });
    expect(res.status).toBe(200);
    const b = await j<{ success: boolean; data: { msgId: string; status: string } }>(res);
    // El sobre es el de ellos, inconsistente incluido: el objetivo es que un
    // cliente existente funcione sin tocar una línea.
    expect(b.success).toBe(true);
    expect(b.data.status).toBe("in_progress");
    expect(b.data.msgId).toBeTruthy();
  });

  it("traduce su vocabulario de medios al nuestro", async () => {
    // Allí es `imageUrl`; aquí es `image: {url}`. La traducción vive en la capa
    // para que /v1 no cargue con dos vocabularios.
    const res = await post("/api/send-message", {
      to: "51988777666", imageUrl: "https://ejemplo.com/foto.png", fileName: "foto.png",
    });
    expect([200, 502]).toContain(res.status);
  });

  it("`/api/status` devuelve el campo PELADO, sin sobre", async () => {
    const res = await app.request("/compat/wasender/api/status", {
      headers: { authorization: `Bearer ${claveUnaLinea}` },
    });
    const b = await j<Record<string, unknown>>(res);
    expect(b["status"]).toBe("connected");
    expect(b["success"]).toBeUndefined();
    expect(b["data"]).toBeUndefined();
  });

  it("con varias líneas al alcance DICE que hay que acotar, no elige al azar", async () => {
    const res = await post("/api/send-message", { to: "51988777666", text: "x" }, claveDosLineas);
    expect(res.status).toBe(409);
    expect((await j<{ detail: string }>(res)).detail).toContain("allowedLines");
  });

  it("sin credencial no pasa", async () => {
    const res = await app.request("/compat/wasender/api/status");
    expect(res.status).toBe(401);
  });
});

run("compatibilidad con Evolution API", () => {
  const post = (path: string, cuerpo: unknown, cabecera: Record<string, string> = {}) =>
    app.request(`/compat/evolution${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cabecera },
      body: JSON.stringify(cuerpo),
    });

  it("acepta la clave en la cabecera `apikey`, que es la suya", async () => {
    const res = await post("/message/sendText/una", { number: "51988777666", text: "desde evolution" },
      { apikey: claveUnaLinea });
    expect(res.status).toBe(201);
    const b = await j<{ key: { id: string; fromMe: boolean }; status: string }>(res);
    expect(b.key.fromMe).toBe(true);
    expect(b.status).toBe("PENDING");
  });

  it("también acepta `Authorization`, para quien ya use la nuestra", async () => {
    const res = await post("/message/sendText/una", { number: "51988777666", text: "otra" },
      { authorization: `Bearer ${claveUnaLinea}` });
    expect(res.status).toBe(201);
  });

  it("la línea va en la RUTA, por su identificador legible", async () => {
    const res = await post("/message/sendText/no-existe", { number: "51988777666", text: "x" },
      { apikey: claveUnaLinea });
    expect(res.status).toBe(404);
  });

  it("traduce el estado a su vocabulario", async () => {
    // Allí `open` es lo que aquí llamamos `connected`.
    const res = await app.request("/compat/evolution/instance/connectionState/una", {
      headers: { apikey: claveUnaLinea },
    });
    const b = await j<{ instance: { state: string } }>(res);
    expect(b.instance.state).toBe("open");
  });

  it("envía medios con su `mediatype`", async () => {
    const res = await post("/message/sendMedia/una", {
      number: "51988777666", mediatype: "image",
      media: "https://ejemplo.com/a.png", caption: "mira",
    }, { apikey: claveUnaLinea });
    expect([201, 502]).toContain(res.status);
  });

  it("respeta el alcance de la clave igual que /v1", async () => {
    // La compatibilidad no es una puerta trasera: los permisos son los mismos.
    const acotada = await mintApiKey();
    await dbh.db.insert(apiKeyTable).values({
      id: "k-compat-3", orgId: ORG, name: "acotada", prefix: acotada.prefix,
      secretHash: acotada.secretHash, role: "operator",
      allowedLines: [LINE], allowedChats: ["51900000000@s.whatsapp.net"],
    });
    const res = await post("/message/sendText/una", { number: "51988777666", text: "fuera" },
      { apikey: acotada.plaintext });
    expect(res.status).toBe(403);
  });
});
