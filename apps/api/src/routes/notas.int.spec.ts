import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiKeyTable, createDatabase, lineTable, migrate, orgMemberTable, orgTable, userTable,
  type DbHandle,
} from "@omni/db";
import { hashPassword } from "@omni/core";
import type { EventEnvelope } from "@omni/shared";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey } from "../keys.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-notas";
const LINE = "line-notas";
const CONTACTO = "51966111222";
const CHAT = `${CONTACTO}@s.whatsapp.net`;
const NOTAS = `/v1/lines/${LINE}/chats/${encodeURIComponent(CHAT)}/notes`;
const CLAVE_CONTRASENA = "contraseña larga de las notas";

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let clave = "";
let claveAcotada = "";
let cookieAna = "";
let cookieBea = "";
const webhooks: { url: string; cuerpo: string }[] = [];

const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;

const conClave = (path: string, init: RequestInit = {}, k = clave) =>
  app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${k}`, "content-type": "application/json", ...init.headers },
  });

const conCookie = (cookie: string, path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { cookie, "content-type": "application/json", ...init.headers },
  });

const entrar = async (email: string): Promise<string> => {
  const r = await app.request("/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: CLAVE_CONTRASENA }),
  });
  return (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
};

const esperar = async (cond: () => Promise<boolean> | boolean, que: string, ms = 8000): Promise<void> => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 70));
  }
  throw new Error(`no se cumplió: ${que}`);
};

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  for (const t of ["message", "chat", "auth_state", "internal_note"]) {
    await dbh.sql.unsafe(`DELETE FROM ${t} WHERE line_id = '${LINE}'`).catch(() => {});
  }
  await dbh.sql`DELETE FROM webhook_endpoint WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.sql`DELETE FROM app_user WHERE id IN ('u-notas-ana', 'u-notas-bea')`;

  await dbh.db.insert(orgTable).values({ id: ORG, name: "Notas", slug: "notas" });
  await dbh.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "L", slug: "l-notas",
    address: "51999888777@s.whatsapp.net", sendRatePerMinute: 6000,
  });
  const hash = await hashPassword(CLAVE_CONTRASENA);
  await dbh.db.insert(userTable).values([
    { id: "u-notas-ana", email: "ana-notas@ejemplo.com", name: "Ana", emailVerified: true, passwordHash: hash },
    { id: "u-notas-bea", email: "bea-notas@ejemplo.com", name: "Bea", emailVerified: true, passwordHash: hash },
  ]);
  await dbh.db.insert(orgMemberTable).values([
    { orgId: ORG, userId: "u-notas-ana", role: "agent" },
    { orgId: ORG, userId: "u-notas-bea", role: "agent" },
  ]);
  const k = await mintApiKey();
  clave = k.plaintext;
  const k2 = await mintApiKey();
  claveAcotada = k2.plaintext;
  await dbh.db.insert(apiKeyTable).values([
    { id: "k-notas", orgId: ORG, name: "admin", prefix: k.prefix, secretHash: k.secretHash, role: "admin" },
    {
      id: "k-notas-chat", orgId: ORG, name: "bot de un chat", prefix: k2.prefix,
      secretHash: k2.secretHash, role: "admin", allowedChats: [CHAT],
    },
  ]);

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "5".repeat(64),
      SANDBOX_ENABLED: "true", MEDIA_DIR: "./.data/test-media-notas",
    } as NodeJS.ProcessEnv),
    {
      runMigrations: false,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        webhooks.push({ url: String(url), cuerpo: String(init?.body ?? "") });
        return new Response("ok");
      }) as unknown as typeof fetch,
    },
  );
  app = createApp(container);
  cookieAna = await entrar("ana-notas@ejemplo.com");
  cookieBea = await entrar("bea-notas@ejemplo.com");

  // Un webhook que lo escucha TODO: si una nota se colara como mensaje
  // saliente, aparecería aquí como `message.sent`.
  await conClave("/v1/webhooks", {
    method: "POST",
    body: JSON.stringify({ url: "https://receptor.test/omni", events: [] }),
  });
  await conClave(`/v1/lines/${LINE}/connect`, { method: "POST" });
  await conClave(`/v1/sandbox/lines/${LINE}/scan`, {
    method: "POST", body: JSON.stringify({ phone: "51999888777" }),
  });
  await conClave(`/v1/sandbox/lines/${LINE}/inbound`, {
    method: "POST", body: JSON.stringify({ from: CONTACTO, text: "hola, ¿me ayudan?" }),
  });
  await esperar(async () => {
    const r = await conClave(`/v1/lines/${LINE}/chats/${encodeURIComponent(CHAT)}`);
    return r.status === 200;
  }, "existe el chat");
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

interface Nota { id: string; body: string; createdAt: string; author: { userId: string | null; name: string | null } }

run("notas internas", () => {
  it("una nota JAMÁS sale por WhatsApp", async () => {
    const texto = "OJO: este cliente reclamó el mes pasado, no prometer plazos";
    const res = await conCookie(cookieAna, NOTAS, { method: "POST", body: JSON.stringify({ body: texto }) });
    expect(res.status).toBe(201);
    const { data } = await j<{ data: Nota }>(res);
    expect(data.author).toMatchObject({ userId: "u-notas-ana", name: "Ana" });

    // Tiempo de sobra para que, si hubiera algún camino hacia la cola de
    // salida, el envío se hubiera hecho ya.
    await new Promise((r) => setTimeout(r, 1500));

    // 1. Lo que la red simulada ha recibido de nosotros: nada con ese texto.
    const hilo = container.sandbox!.thread(LINE as never, CHAT);
    expect(hilo.some((m) => (m.text ?? "").includes("reclamó")), "la nota llegó al teléfono del cliente")
      .toBe(false);
    expect(hilo.filter((m) => m.fromMe)).toHaveLength(0);

    // 2. Ni una fila en `message`, que es de donde lee la cola de salida.
    const filas = await dbh.sql`SELECT 1 FROM message WHERE line_id = ${LINE} AND body LIKE ${"%reclamó%"}`;
    expect(filas).toHaveLength(0);

    // 3. Ni un `message.sent` en los webhooks.
    expect(webhooks.some((w) => w.cuerpo.includes("message.sent"))).toBe(false);

    // 4. El historial del chat no la trae como mensaje.
    const { data: mensajes } = await j<{ data: { body: string | null }[] }>(
      await conClave(`/v1/lines/${LINE}/chats/${encodeURIComponent(CHAT)}/messages`));
    expect(mensajes.some((m) => (m.body ?? "").includes("reclamó"))).toBe(false);

    // Y el equipo sí la ve, en su sitio.
    const { data: notas } = await j<{ data: Nota[] }>(await conCookie(cookieBea, NOTAS));
    expect(notas.map((n) => n.body)).toContain(texto);
  });

  it("sale en vivo, para que la vea quien tiene el chat abierto", async () => {
    const eventos: EventEnvelope[] = [];
    const off = await container.bus.subscribe<EventEnvelope>(`org:${ORG}`, (e) => {
      if (e.event.startsWith("note.")) eventos.push(e);
    });
    try {
      await conCookie(cookieBea, NOTAS, { method: "POST", body: JSON.stringify({ body: "le llamo yo" }) });
      await esperar(() => eventos.some((e) =>
        e.event === "note.created" && (e.data as Nota & { chatId: string }).chatId === CHAT),
      "llegó la nota por el bus");
    } finally {
      await off();
    }
  });

  it("de la más nueva a la más vieja, y se pagina con `before`", async () => {
    const { data, meta } = await j<{ data: Nota[]; meta: { nextBefore: string | null } }>(
      await conClave(`${NOTAS}?limit=1`));
    expect(data[0]!.body).toBe("le llamo yo");
    expect(meta.nextBefore).not.toBeNull();
    const siguiente = await j<{ data: Nota[] }>(
      await conClave(`${NOTAS}?limit=1&before=${encodeURIComponent(meta.nextBefore!)}`));
    expect(siguiente.data[0]!.body).toContain("reclamó");
  });

  it("solo quien la escribió puede borrarla", async () => {
    const { data } = await j<{ data: Nota[] }>(await conClave(NOTAS));
    const deAna = data.find((n) => n.author.userId === "u-notas-ana")!;

    const ajena = await conCookie(cookieBea, `${NOTAS}/${deAna.id}`, { method: "DELETE" });
    expect(ajena.status).toBe(403);

    const propia = await conCookie(cookieAna, `${NOTAS}/${deAna.id}`, { method: "DELETE" });
    expect(propia.status).toBe(200);
    const despues = await j<{ data: Nota[] }>(await conClave(NOTAS));
    expect(despues.data.some((n) => n.id === deAna.id)).toBe(false);
  });

  it("una clave acotada a un chat no lee lo que el equipo dice de él", async () => {
    const res = await conClave(NOTAS, {}, claveAcotada);
    expect(res.status).toBe(403);
  });

  it("una nota vacía no se guarda", async () => {
    const res = await conCookie(cookieAna, NOTAS, { method: "POST", body: JSON.stringify({ body: "   " }) });
    expect(res.status).toBe(422);
  });
});
