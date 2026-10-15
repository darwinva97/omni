import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiKeyTable, createDatabase, lineTable, migrate, orgTable, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey } from "../keys.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-qr";
const OTRA_ORG = "org-qr-2";
const LINE = "line-qr";

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let admin = "";
let lector = "";
let deLinea = "";
let ajena = "";

const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  for (const org of [ORG, OTRA_ORG]) {
    await dbh.sql`DELETE FROM quick_reply WHERE org_id = ${org}`;
    await dbh.sql`DELETE FROM api_key WHERE org_id = ${org}`;
    await dbh.sql`DELETE FROM line WHERE org_id = ${org}`;
    await dbh.sql`DELETE FROM org WHERE id = ${org}`;
  }
  await dbh.db.insert(orgTable).values([
    { id: ORG, name: "Respuestas", slug: "respuestas" },
    { id: OTRA_ORG, name: "Otra", slug: "respuestas-otra" },
  ]);
  await dbh.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "L", slug: "l-qr", sendRatePerMinute: 6000,
  });

  const clave = async (id: string, org: string, role: "admin" | "viewer", allowedLines: string[] = []) => {
    const k = await mintApiKey();
    await dbh.db.insert(apiKeyTable).values({
      id, orgId: org, name: id, prefix: k.prefix, secretHash: k.secretHash, role, allowedLines,
    });
    return k.plaintext;
  };
  admin = await clave("k-qr-admin", ORG, "admin");
  lector = await clave("k-qr-lector", ORG, "viewer");
  deLinea = await clave("k-qr-linea", ORG, "admin", [LINE]);
  ajena = await clave("k-qr-ajena", OTRA_ORG, "admin");

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "6".repeat(64),
      SANDBOX_ENABLED: "true", MEDIA_DIR: "./.data/test-media-qr",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

const llamar = (path: string, init: RequestInit = {}, clave = admin) =>
  app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${clave}`, "content-type": "application/json", ...init.headers },
  });
const crear = (shortcut: string, text: string, clave = admin) =>
  llamar("/v1/quick-replies", { method: "POST", body: JSON.stringify({ shortcut, text }) }, clave);
const lista = async (clave = admin) =>
  (await j<{ data: { id: string; shortcut: string; text: string }[] }>(
    await llamar("/v1/quick-replies", {}, clave))).data;

run("respuestas rápidas", () => {
  let precios = "";

  it("el atajo se guarda sin barra y en minúsculas, y sale ordenado", async () => {
    const r = await crear("/Precios", "El plan anual cuesta 120 €, con factura.");
    expect(r.status).toBe(201);
    precios = (await j<{ data: { id: string; shortcut: string } }>(r)).data.id;
    expect((await crear("horario", "De 9 a 18 h, de lunes a viernes.")).status).toBe(201);
    expect((await lista()).map((q) => q.shortcut)).toEqual(["horario", "precios"]);
  });

  it("un atajo repetido da 409, aunque se escriba distinto", async () => {
    const r = await crear("PRECIOS", "otra cosa");
    expect(r.status).toBe(409);
    expect((await j<{ detail: string }>(r)).detail).toContain("/precios");
  });

  it("un atajo con espacios o vacío se rechaza con el motivo", async () => {
    const r = await crear("dos palabras", "x");
    expect(r.status).toBe(422);
    expect((await j<{ detail: string }>(r)).detail).toContain("una sola palabra");
    expect((await crear("/", "x")).status).toBe(422);
    expect((await crear("vacio", "   ")).status).toBe(422);
  });

  it("se cambia el texto y el atajo; chocar con otro da 409", async () => {
    const r = await llamar(`/v1/quick-replies/${precios}`, {
      method: "PATCH", body: JSON.stringify({ shortcut: "/tarifa", text: "120 € al año." }),
    });
    expect(r.status).toBe(200);
    expect((await j<{ data: { shortcut: string; text: string } }>(r)).data)
      .toMatchObject({ shortcut: "tarifa", text: "120 € al año." });
    const choque = await llamar(`/v1/quick-replies/${precios}`, {
      method: "PATCH", body: JSON.stringify({ shortcut: "horario" }),
    });
    expect(choque.status).toBe(409);
  });

  it("quien solo lee las ve pero no las cambia", async () => {
    expect((await lista(lector)).length).toBe(2);
    expect((await crear("nueva", "x", lector)).status).toBe(403);
    expect((await llamar(`/v1/quick-replies/${precios}`, { method: "DELETE" }, lector)).status).toBe(403);
  });

  it("son de la organización: otra no las ve ni las toca", async () => {
    expect(await lista(ajena)).toEqual([]);
    expect((await llamar(`/v1/quick-replies/${precios}`, { method: "DELETE" }, ajena)).status).toBe(404);
  });

  it("una clave limitada a líneas no llega a lo de la organización", async () => {
    expect((await llamar("/v1/quick-replies", {}, deLinea)).status).toBe(403);
  });

  it("se borra, y borrar lo que no existe es 404", async () => {
    expect((await llamar(`/v1/quick-replies/${precios}`, { method: "DELETE" })).status).toBe(200);
    expect((await llamar(`/v1/quick-replies/${precios}`, { method: "DELETE" })).status).toBe(404);
    expect((await lista()).map((q) => q.shortcut)).toEqual(["horario"]);
  });
});
