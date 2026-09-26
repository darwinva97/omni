import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiKeyTable, createDatabase, lineTable, migrate, orgTable, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey } from "../keys.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-lbl";
const LINE = "line-lbl";
const OTRA = "line-lbl-2";
const CHAT = "51988777666@s.whatsapp.net";

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let admin = "";
let acotada = "";

const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  for (const l of [LINE, OTRA]) {
    for (const t of ["label_assignment", "label", "message", "chat", "auth_state"]) {
      await dbh.sql.unsafe(`DELETE FROM ${t} WHERE line_id = '${l}'`).catch(() => {});
    }
  }
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.db.insert(orgTable).values({ id: ORG, name: "Etiquetas", slug: "etiquetas" });
  await dbh.db.insert(lineTable).values([
    { id: LINE, orgId: ORG, channelKind: "sandbox", name: "Una", slug: "una-lbl", sendRatePerMinute: 6000 },
    { id: OTRA, orgId: ORG, channelKind: "sandbox", name: "Otra", slug: "otra-lbl", sendRatePerMinute: 6000 },
  ]);

  const a = await mintApiKey();
  admin = a.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-lbl-admin", orgId: ORG, name: "admin", prefix: a.prefix, secretHash: a.secretHash, role: "admin",
  });
  const b = await mintApiKey();
  acotada = b.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-lbl-chat", orgId: ORG, name: "agente", prefix: b.prefix, secretHash: b.secretHash,
    role: "operator", allowedLines: [LINE], allowedChats: [CHAT],
  });

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "4".repeat(64),
      SANDBOX_ENABLED: "true", MEDIA_DIR: "./.data/test-media-lbl",
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

const enc = encodeURIComponent;

run("etiquetas", () => {
  let idUrgente = "";
  let idOtraLinea = "";

  it("crea una etiqueta y rechaza el nombre repetido", async () => {
    const res = await llamar(`/v1/lines/${LINE}/labels`, {
      method: "POST", body: JSON.stringify({ name: "urgente", color: "rojo" }),
    });
    expect(res.status).toBe(201);
    const { data } = await j<{ data: { id: string; usos: number } }>(res);
    idUrgente = data.id;
    expect(data.usos).toBe(0);

    // Dos con el mismo nombre serían indistinguibles en el panel y en la API.
    const repetida = await llamar(`/v1/lines/${LINE}/labels`, {
      method: "POST", body: JSON.stringify({ name: "urgente" }),
    });
    expect(repetida.status).toBe(409);
  });

  it("el mismo nombre SÍ vale en otra línea", async () => {
    const res = await llamar(`/v1/lines/${OTRA}/labels`, {
      method: "POST", body: JSON.stringify({ name: "urgente" }),
    });
    expect(res.status).toBe(201);
    idOtraLinea = (await j<{ data: { id: string } }>(res)).data.id;
  });

  it("rechaza un color que no está en la lista", async () => {
    const res = await llamar(`/v1/lines/${LINE}/labels`, {
      method: "POST", body: JSON.stringify({ name: "otra", color: "fucsia-neón" }),
    });
    expect(res.status).toBe(422);
  });

  it("fija las etiquetas de una conversación reemplazando el conjunto", async () => {
    const segunda = await j<{ data: { id: string } }>(
      await llamar(`/v1/lines/${LINE}/labels`, {
        method: "POST", body: JSON.stringify({ name: "pendiente", color: "ámbar" }),
      }),
    );

    const puestas = await llamar(`/v1/lines/${LINE}/chats/${enc(CHAT)}/labels`, {
      method: "PUT", body: JSON.stringify({ labelIds: [idUrgente, segunda.data.id] }),
    });
    expect(puestas.status).toBe(200);

    // Reemplaza, no añade: el resultado no depende de lo que hubiera antes.
    const reemplazadas = await llamar(`/v1/lines/${LINE}/chats/${enc(CHAT)}/labels`, {
      method: "PUT", body: JSON.stringify({ labelIds: [idUrgente] }),
    });
    expect((await j<{ data: { labelIds: string[] } }>(reemplazadas)).data.labelIds).toEqual([idUrgente]);
  });

  it("NO deja pegar una etiqueta de otra línea", async () => {
    const res = await llamar(`/v1/lines/${LINE}/chats/${enc(CHAT)}/labels`, {
      method: "PUT", body: JSON.stringify({ labelIds: [idOtraLinea] }),
    });
    expect(res.status).toBe(422);
    expect((await j<{ detail: string }>(res)).detail).toContain("no son de esta línea");
  });

  it("cuenta los usos al listar", async () => {
    const { data } = await j<{ data: { name: string; usos: number }[] }>(
      await llamar(`/v1/lines/${LINE}/labels`),
    );
    expect(data.find((l) => l.name === "urgente")?.usos).toBe(1);
    expect(data.find((l) => l.name === "pendiente")?.usos).toBe(0);
  });

  it("lista las conversaciones de una etiqueta", async () => {
    const { data } = await j<{ data: { target: string }[] }>(
      await llamar(`/v1/lines/${LINE}/labels/${idUrgente}/chats`),
    );
    expect(data.map((d) => d.target)).toEqual([CHAT]);
  });

  it("una clave acotada puede etiquetar SU chat pero no gestionar etiquetas", async () => {
    // Etiquetar es parte de trabajar una conversación; crear o borrar etiquetas
    // de la línea no lo es.
    const etiquetar = await llamar(`/v1/lines/${LINE}/chats/${enc(CHAT)}/labels`, {
      method: "PUT", body: JSON.stringify({ labelIds: [idUrgente] }),
    }, acotada);
    expect(etiquetar.status).toBe(200);

    const crear = await llamar(`/v1/lines/${LINE}/labels`, {
      method: "POST", body: JSON.stringify({ name: "suya" }),
    }, acotada);
    expect(crear.status).toBe(403);
  });

  it("una clave acotada no etiqueta un chat ajeno", async () => {
    const res = await llamar(`/v1/lines/${LINE}/chats/${enc("51900000000@s.whatsapp.net")}/labels`, {
      method: "PUT", body: JSON.stringify({ labelIds: [idUrgente] }),
    }, acotada);
    expect(res.status).toBe(403);
  });

  it("borrar una etiqueta la quita de donde estuviera", async () => {
    const res = await llamar(`/v1/lines/${LINE}/labels/${idUrgente}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const restantes = await dbh.sql`
      SELECT 1 FROM label_assignment WHERE label_id = ${idUrgente}`;
    expect(restantes).toHaveLength(0);
  });

  it("borrar una que no existe es 404", async () => {
    expect((await llamar(`/v1/lines/${LINE}/labels/no-existe`, { method: "DELETE" })).status).toBe(404);
  });
});
