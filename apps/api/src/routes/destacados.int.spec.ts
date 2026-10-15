import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiKeyTable, createDatabase, lineTable, messageTable, migrate, orgTable, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey } from "../keys.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-dst";
const LINE = "line-dst";
const CHAT = "51988777666@s.whatsapp.net";
const OTRO = "51977666555@s.whatsapp.net";

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let ana = "";
let bruno = "";
let acotada = "";

const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  for (const t of ["starred_message", "message", "chat", "auth_state"]) {
    await dbh.sql.unsafe(`DELETE FROM ${t} WHERE line_id = '${LINE}'`).catch(() => {});
  }
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.db.insert(orgTable).values({ id: ORG, name: "Destacados", slug: "destacados" });
  await dbh.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "L", slug: "l-dst", sendRatePerMinute: 6000,
  });

  // Dos claves de administración: dos «personas» con sus propias estrellas.
  for (const [id, guardar] of [
    ["k-dst-ana", (k: string) => { ana = k; }],
    ["k-dst-bruno", (k: string) => { bruno = k; }],
  ] as const) {
    const k = await mintApiKey();
    guardar(k.plaintext);
    await dbh.db.insert(apiKeyTable).values({
      id, orgId: ORG, name: id, prefix: k.prefix, secretHash: k.secretHash, role: "admin",
    });
  }
  const c = await mintApiKey();
  acotada = c.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-dst-chat", orgId: ORG, name: "agente", prefix: c.prefix, secretHash: c.secretHash,
    role: "viewer", allowedLines: [LINE], allowedChats: [CHAT],
  });

  const ahora = Date.now();
  await dbh.db.insert(messageTable).values([
    { id: "m-dst-1", timestamp: new Date(ahora - 60_000), lineId: LINE, chatId: CHAT,
      providerMessageId: "P1", senderAddress: CHAT, fromMe: false, kind: "text", body: "el precio es 120", state: "delivered" },
    { id: "m-dst-2", timestamp: new Date(ahora - 30_000), lineId: LINE, chatId: CHAT,
      providerMessageId: "P2", senderAddress: "51999888777@s.whatsapp.net", fromMe: true, kind: "text", body: "apuntado", state: "read" },
    { id: "m-dst-3", timestamp: new Date(ahora - 20_000), lineId: LINE, chatId: OTRO,
      providerMessageId: "P3", senderAddress: OTRO, fromMe: false, kind: "text", body: "de otro chat", state: "delivered" },
  ]);

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "5".repeat(64),
      SANDBOX_ENABLED: "true", MEDIA_DIR: "./.data/test-media-dst",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

const llamar = (path: string, init: RequestInit = {}, clave = ana) =>
  app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${clave}`, "content-type": "application/json", ...init.headers },
  });

const enc = encodeURIComponent;
const estrella = (chat: string, id: string) => `/v1/lines/${LINE}/chats/${enc(chat)}/messages/${enc(id)}/star`;
const destacados = async (clave = ana) =>
  (await j<{ data: { id: string; body: string; senderName: string | null; timestamp: string }[] }>(
    await llamar(`/v1/lines/${LINE}/chats/${enc(CHAT)}/starred`, {}, clave))).data;

run("mensajes destacados", () => {
  it("se destaca por el id de Omni o por el de WhatsApp, y destacar dos veces no duplica", async () => {
    expect((await llamar(estrella(CHAT, "m-dst-1"), { method: "PUT" })).status).toBe(200);
    expect((await llamar(estrella(CHAT, "P2"), { method: "PUT" })).status).toBe(200);
    expect((await llamar(estrella(CHAT, "P2"), { method: "PUT" })).status).toBe(200);

    const lista = await destacados();
    // El último destacado, primero.
    expect(lista.map((m) => m.id)).toEqual(["m-dst-2", "m-dst-1"]);
    // Con lo necesario para ir a él: cuándo se escribió y de quién es.
    expect(lista[1]).toMatchObject({ body: "el precio es 120", senderName: "+51988777666" });
  });

  it("la estrella es de quien la pone: Bruno no ve las de Ana", async () => {
    expect(await destacados(bruno)).toEqual([]);
    const { data } = await j<{ data: { id: string; starred: boolean }[] }>(
      await llamar(`/v1/lines/${LINE}/chats/${enc(CHAT)}/messages?limit=10`, {}, bruno));
    expect(data.every((m) => !m.starred)).toBe(true);
  });

  it("el hilo dice cuáles tiene destacados quien lo pide", async () => {
    const { data } = await j<{ data: { id: string; starred: boolean }[] }>(
      await llamar(`/v1/lines/${LINE}/chats/${enc(CHAT)}/messages?limit=10`));
    expect(Object.fromEntries(data.map((m) => [m.id, m.starred])))
      .toEqual({ "m-dst-1": true, "m-dst-2": true });
  });

  it("se quita, y quitar lo que no estaba no falla", async () => {
    expect((await llamar(estrella(CHAT, "m-dst-1"), { method: "DELETE" })).status).toBe(200);
    expect((await llamar(estrella(CHAT, "m-dst-1"), { method: "DELETE" })).status).toBe(200);
    expect((await destacados()).map((m) => m.id)).toEqual(["m-dst-2"]);
  });

  it("lo borrado para todos deja de salir, como en WhatsApp", async () => {
    await dbh.sql`UPDATE message SET deleted_at = now() WHERE id = 'm-dst-2'`;
    expect(await destacados()).toEqual([]);
  });

  it("un mensaje de otro chat no se destaca dando su id desde este", async () => {
    const r = await llamar(estrella(CHAT, "m-dst-3"), { method: "PUT" });
    expect(r.status).toBe(404);
  });

  it("una clave acotada destaca en su chat, aunque solo pueda leer, y no en otro", async () => {
    expect((await llamar(estrella(CHAT, "m-dst-1"), { method: "PUT" }, acotada)).status).toBe(200);
    expect((await destacados(acotada)).map((m) => m.id)).toEqual(["m-dst-1"]);
    expect((await llamar(estrella(OTRO, "m-dst-3"), { method: "PUT" }, acotada)).status).toBe(403);
  });
});
