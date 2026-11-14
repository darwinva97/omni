import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiKeyTable, createDatabase, lineTable, migrate, orgMemberTable, orgTable, sessionTable, userTable,
  type DbHandle,
} from "@omni/db";
import { generateToken, hashToken } from "@omni/core";
import { MemoryBus } from "@omni/platform";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey } from "../keys.js";
import { RealtimeGateway, visibleFor } from "../realtime/gateway.js";
import { avisarCambioDeAcceso } from "../alcance.js";

/**
 * Compartir unos chats con una persona del equipo sin abrirle el resto.
 *
 * Es el mismo alcance que el de una clave de API, y estas pruebas comprueban
 * que la persona choca con las mismas paredes: lo que no ve por un listado
 * tampoco lo abre por la ruta directa, ni por la bandeja, ni por la búsqueda.
 */

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-alcance";
const L1 = "line-alcance-1";
const L2 = "line-alcance-2";
const DUENO = "u-alcance-dueno";
const ACOTADA = "u-alcance-acotada";
const LECTORA = "u-alcance-lectora";
const LIBRE = "u-alcance-libre";
const CREADORA = "u-alcance-creadora";
const A = "51911100011@s.whatsapp.net";
const B = "51922200022@s.whatsapp.net";
const C = "51933300033@s.whatsapp.net";

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let clave = "";
const cookies: Record<string, string> = {};

const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;

const conClave = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${clave}`, "content-type": "application/json", ...init.headers },
  });

const como = (quien: string, path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { cookie: cookies[quien]!, "content-type": "application/json", ...init.headers },
  });

const esperar = async (cond: () => Promise<boolean>, que: string, ms = 8000): Promise<void> => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 70));
  }
  throw new Error(`no se cumplió: ${que}`);
};

const sesion = async (userId: string): Promise<string> => {
  const token = generateToken();
  await dbh.db.insert(sessionTable).values({
    id: await hashToken(token), userId, activeOrgId: ORG,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return `omni_session=${token}`;
};

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  await dbh.sql`DELETE FROM conversation WHERE org_id = ${ORG}`;
  for (const t of ["message", "chat", "auth_state", "label_assignment", "contact"]) {
    await dbh.sql.unsafe(`DELETE FROM ${t} WHERE line_id IN ('${L1}', '${L2}')`).catch(() => {});
  }
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM invitation WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.sql`DELETE FROM app_user WHERE id IN (${DUENO}, ${ACOTADA}, ${LECTORA}, ${LIBRE}, ${CREADORA})`;
  await dbh.sql`DELETE FROM app_user WHERE email IN ('invitada-alcance@ejemplo.com', 'crea-alcance@ejemplo.com')`;

  await dbh.db.insert(orgTable).values({ id: ORG, name: "Alcance", slug: "alcance" });
  await dbh.db.insert(userTable).values([
    { id: DUENO, email: "dueno-alcance@ejemplo.com", name: "Dueña", emailVerified: true },
    { id: ACOTADA, email: "acotada-alcance@ejemplo.com", name: "Acotada", emailVerified: true },
    { id: LECTORA, email: "lectora-alcance@ejemplo.com", name: "Lectora", emailVerified: true },
    { id: LIBRE, email: "libre-alcance@ejemplo.com", name: "Libre", emailVerified: true },
    { id: CREADORA, email: "creadora-alcance@ejemplo.com", name: "Creadora", emailVerified: true },
  ]);
  await dbh.db.insert(orgMemberTable).values([
    { orgId: ORG, userId: DUENO, role: "owner" },
    { orgId: ORG, userId: ACOTADA, role: "agent", restricted: true, allowedLines: [L1], allowedChats: [A] },
    { orgId: ORG, userId: LECTORA, role: "viewer", restricted: true, allowedLines: [L1], allowedChats: [A] },
    { orgId: ORG, userId: LIBRE, role: "agent" },
    // Ninguna línea tuya, pero puede dar de alta las suyas.
    { orgId: ORG, userId: CREADORA, role: "agent", restricted: true, canCreateLines: true },
  ]);
  await dbh.db.insert(lineTable).values([
    { id: L1, orgId: ORG, channelKind: "sandbox", name: "Uno", slug: "uno", address: "51900000001@s.whatsapp.net", sendRatePerMinute: 6000 },
    { id: L2, orgId: ORG, channelKind: "sandbox", name: "Dos", slug: "dos", address: "51900000002@s.whatsapp.net", sendRatePerMinute: 6000 },
  ]);
  const k = await mintApiKey();
  clave = k.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-alcance", orgId: ORG, name: "admin", prefix: k.prefix, secretHash: k.secretHash, role: "admin",
  });
  for (const u of [DUENO, ACOTADA, LECTORA, LIBRE, CREADORA]) cookies[u] = await sesion(u);

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "5".repeat(64),
      SANDBOX_ENABLED: "true", MEDIA_DIR: "./.data/test-media-alcance",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);

  for (const [linea, tel] of [[L1, "51900000001"], [L2, "51900000002"]] as const) {
    await conClave(`/v1/lines/${linea}/connect`, { method: "POST" });
    await conClave(`/v1/sandbox/lines/${linea}/scan`, { method: "POST", body: JSON.stringify({ phone: tel }) });
  }
  const entrante = (linea: string, de: string, text: string) =>
    conClave(`/v1/sandbox/lines/${linea}/inbound`, {
      method: "POST", body: JSON.stringify({ from: de.split("@")[0], text }),
    });
  await entrante(L1, A, "hola desde A");
  await entrante(L1, B, "secreto de B");
  await entrante(L2, C, "secreto de C");
  await esperar(async () => {
    const { data } = await j<{ data: unknown[] }>(await conClave("/v1/conversations"));
    return data.length === 3;
  }, "llegaron los tres mensajes");
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

run("una persona acotada a unos chats", () => {
  it("sabe cuál es su alcance", async () => {
    const { data } = await j<{ data: { role: string; allowedLines: string[]; allowedChats: string[] } }>(
      await como(ACOTADA, "/v1/auth/me"),
    );
    expect(data).toMatchObject({ role: "agent", restricted: true, allowedLines: [L1], allowedChats: [A] });
  });

  it("ve solo su línea y solo su chat", async () => {
    const lineas = await j<{ data: { id: string }[] }>(await como(ACOTADA, "/v1/lines"));
    expect(lineas.data.map((l) => l.id)).toEqual([L1]);

    const chats = await j<{ data: { address: string }[] }>(await como(ACOTADA, `/v1/lines/${L1}/chats`));
    expect(chats.data.map((c) => c.address)).toEqual([A]);
  });

  it("lee y escribe en su chat", async () => {
    const leer = await como(ACOTADA, `/v1/lines/${L1}/chats/${A}/messages`);
    expect(leer.status).toBe(200);
    const enviar = await como(ACOTADA, `/v1/lines/${L1}/messages`, {
      method: "POST", body: JSON.stringify({ to: A, text: "te atiendo yo" }),
    });
    expect(enviar.status).toBeLessThan(300);
  });

  it("no abre otro chat de la misma línea por la ruta directa", async () => {
    expect((await como(ACOTADA, `/v1/lines/${L1}/chats/${B}/messages`)).status).toBe(403);
    const enviar = await como(ACOTADA, `/v1/lines/${L1}/messages`, {
      method: "POST", body: JSON.stringify({ to: B, text: "hola" }),
    });
    expect(enviar.status).toBe(403);
  });

  it("una línea ajena da 401, sin confirmar que existe", async () => {
    expect((await como(ACOTADA, `/v1/lines/${L2}/chats`)).status).toBe(401);
    expect((await como(ACOTADA, `/v1/lines/${L2}/chats/${C}/messages`)).status).toBe(401);
  });

  it("la bandeja y la búsqueda no son una puerta lateral", async () => {
    const bandeja = await j<{ data: { chatId: string }[] }>(await como(ACOTADA, "/v1/conversations"));
    expect(bandeja.data.map((c) => c.chatId)).toEqual([A]);

    const busqueda = await j<{ data: { chatId?: string; chat?: string }[] }>(
      await como(ACOTADA, `/v1/lines/${L1}/messages/search?q=secreto`),
    );
    expect(busqueda.data).toHaveLength(0);
  });

  it("no ve el equipo, ni las notas, ni las respuestas de la organización", async () => {
    expect((await como(ACOTADA, "/v1/members")).status).toBe(403);
    expect((await como(ACOTADA, "/v1/quick-replies")).status).toBe(403);
    expect((await como(ACOTADA, `/v1/lines/${L1}/chats/${A}/notes`)).status).toBe(403);
  });

  it("como viewer lee su chat pero no escribe", async () => {
    expect((await como(LECTORA, `/v1/lines/${L1}/chats/${A}/messages`)).status).toBe(200);
    const enviar = await como(LECTORA, `/v1/lines/${L1}/messages`, {
      method: "POST", body: JSON.stringify({ to: A, text: "no debería salir" }),
    });
    expect(enviar.status).toBe(403);
  });

  it("alguien SIN alcance sigue viéndolo todo", async () => {
    const lineas = await j<{ data: { id: string }[] }>(await como(LIBRE, "/v1/lines"));
    expect(lineas.data.map((l) => l.id).sort()).toEqual([L1, L2]);
    const bandeja = await j<{ data: unknown[] }>(await como(LIBRE, "/v1/conversations"));
    expect(bandeja.data).toHaveLength(3);
  });
});

run("gestionar el alcance", () => {
  it("el equipo enseña el alcance de cada uno", async () => {
    const { data } = await j<{ data: { userId: string; allowedChats: string[] }[] }>(
      await como(DUENO, "/v1/members"),
    );
    expect(data.find((m) => m.userId === ACOTADA)?.allowedChats).toEqual([A]);
    expect(data.find((m) => m.userId === LIBRE)?.allowedChats).toEqual([]);
  });

  it("la dueña amplía el alcance y vale desde la siguiente petición", async () => {
    const res = await como(DUENO, `/v1/members/${ACOTADA}/scope`, {
      // Un teléfono suelto se normaliza a la dirección que compara el guardián.
      method: "PUT", body: JSON.stringify({ allowedLines: [L1], allowedChats: [A, "51922200022"] }),
    });
    expect(res.status).toBe(200);
    expect((await j<{ data: { allowedChats: string[] } }>(res)).data.allowedChats).toEqual([A, B]);
    expect((await como(ACOTADA, `/v1/lines/${L1}/chats/${B}/messages`)).status).toBe(200);
  });

  it("y lo vuelve a cerrar", async () => {
    await como(DUENO, `/v1/members/${ACOTADA}/scope`, {
      method: "PUT", body: JSON.stringify({ allowedLines: [L1], allowedChats: [A] }),
    });
    expect((await como(ACOTADA, `/v1/lines/${L1}/chats/${B}/messages`)).status).toBe(403);
  });

  it("unos chats sin sus líneas no valen", async () => {
    const res = await como(DUENO, `/v1/members/${ACOTADA}/scope`, {
      method: "PUT", body: JSON.stringify({ allowedLines: [], allowedChats: [A] }),
    });
    expect(res.status).toBe(422);
  });

  it("una línea de otra organización no vale", async () => {
    const res = await como(DUENO, `/v1/members/${ACOTADA}/scope`, {
      method: "PUT", body: JSON.stringify({ allowedLines: ["line-de-otro"], allowedChats: [] }),
    });
    expect(res.status).toBe(422);
  });

  it("un rol de gestión no se acota, ni se da a quien está acotado", async () => {
    const subir = await como(DUENO, `/v1/members/${ACOTADA}`, {
      method: "PATCH", body: JSON.stringify({ role: "manager" }),
    });
    expect(subir.status).toBe(409);
    const dueno = await como(DUENO, `/v1/members/${DUENO}/scope`, {
      method: "PUT", body: JSON.stringify({ allowedLines: [L1], allowedChats: [] }),
    });
    expect(dueno.status).toBe(422);
  });

  it("una persona acotada no puede cambiar su propio alcance", async () => {
    const res = await como(ACOTADA, `/v1/members/${ACOTADA}/scope`, {
      method: "PUT", body: JSON.stringify({ allowedLines: [], allowedChats: [] }),
    });
    expect(res.status).toBe(403);
  });

  it("se invita ya acotada, y entra acotada", async () => {
    const inv = await como(DUENO, "/v1/invitations", {
      method: "POST",
      body: JSON.stringify({
        email: "invitada-alcance@ejemplo.com", role: "viewer", allowedLines: [L1], allowedChats: [A],
      }),
    });
    expect(inv.status).toBe(201);
    const { data } = await j<{ data: { token: string; allowedChats: string[] } }>(inv);
    expect(data.allowedChats).toEqual([A]);

    const aceptada = await app.request("/v1/invitations/accept", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: data.token, name: "Invitada", password: "una contraseña larga" }),
    });
    expect(aceptada.status).toBe(201);
    const cookie = (aceptada.headers.get("set-cookie") ?? "").split(";")[0]!;
    const lineas = await j<{ data: { id: string }[] }>(await app.request("/v1/lines", { headers: { cookie } }));
    expect(lineas.data.map((l) => l.id)).toEqual([L1]);
  });

  it("una invitación con un alcance inválido no se crea", async () => {
    const inv = await como(DUENO, "/v1/invitations", {
      method: "POST",
      body: JSON.stringify({ email: "x-alcance@ejemplo.com", role: "manager", allowedLines: [L1] }),
    });
    expect(inv.status).toBe(422);
  });
});

run("tiempo real", () => {
  it("el billete de una persona acotada lleva su alcance", async () => {
    const res = await como(ACOTADA, "/v1/realtime/ticket", { method: "POST" });
    expect(res.status).toBe(201);
    const { data } = await j<{ data: { ticket: string } }>(res);
    const crudo = await container.kv.get(`wsticket:${data.ticket}`);
    expect(JSON.parse(crudo!)).toMatchObject({
      kind: "user", allowedLines: [L1], allowedChats: [A], sinEnlace: true,
    });
  });

  it("el QR de enlace no le llega por el socket", () => {
    const qr = { id: "e", event: "session.qr" as const, orgId: ORG, lineId: L1, timestamp: 0, data: { qr: "x" } };
    const base = { orgId: ORG, kind: "user" as const, userId: ACOTADA, allowedLines: [L1], allowedChats: [] };
    expect(visibleFor({ ...base, sinEnlace: true }, qr)).toBe(false);
    expect(visibleFor({ ...base, sinEnlace: false }, qr)).toBe(true);
  });

  it("al cambiarle el acceso se le cierran los sockets abiertos, y a nadie más", async () => {
    const bus = new MemoryBus();
    const gateway = new RealtimeGateway(bus);
    const cerrados: string[] = [];
    const billete = (userId: string) => ({
      orgId: ORG, kind: "user" as const, userId, allowedLines: [], allowedChats: [],
    });
    await gateway.añadir("s1", billete(ACOTADA), () => {}, () => cerrados.push("s1"));
    await gateway.añadir("s2", billete(LIBRE), () => {}, () => cerrados.push("s2"));
    await avisarCambioDeAcceso(bus, ORG, ACOTADA);
    await esperar(async () => cerrados.length > 0, "se cerró el socket");
    expect(cerrados).toEqual(["s1"]);
    expect(gateway.conexionesAbiertas).toBe(1);
  });
});

run("el enlace de la línea", () => {
  it("una persona acotada ve si la línea está viva, pero no el QR para quedársela", async () => {
    // Quien escanea el QR con SU teléfono se queda con la línea.
    const L3 = "line-alcance-3";
    await dbh.db.insert(lineTable).values({
      id: L3, orgId: ORG, channelKind: "sandbox", name: "Tres", slug: "tres", sendRatePerMinute: 6000,
    });
    await como(DUENO, `/v1/members/${ACOTADA}/scope`, {
      method: "PUT", body: JSON.stringify({ allowedLines: [L1, L3], allowedChats: [A] }),
    });
    const conectar = await j<{ data: { state: string } }>(
      await conClave(`/v1/lines/${L3}/connect`, { method: "POST" }),
    );
    expect(conectar.data.state).toBe("awaiting-link");

    const dueno = await j<{ data: { qr?: string } }>(await como(DUENO, `/v1/lines/${L3}/status`));
    expect(dueno.data.qr).toBeTruthy();
    const acotada = await como(ACOTADA, `/v1/lines/${L3}/status`);
    expect(acotada.status).toBe(200);
    const { data } = await j<{ data: { state: string; qr?: string; pairingCode?: string } }>(acotada);
    expect(data.state).toBe("awaiting-link");
    expect(data.qr).toBeUndefined();
    expect(data.pairingCode).toBeUndefined();
  });
});

run("una persona que da de alta sus propias líneas", () => {
  let mia = "";

  it("limitada a ninguna línea tuya no ve ninguna, no todas", async () => {
    const { data } = await j<{ data: { id: string }[] }>(await como(CREADORA, "/v1/lines"));
    expect(data).toEqual([]);
    expect((await como(CREADORA, `/v1/lines/${L1}/chats`)).status).toBe(401);
    expect((await como(CREADORA, "/v1/conversations")).status).toBe(200);
    expect((await j<{ data: unknown[] }>(await como(CREADORA, "/v1/conversations"))).data).toEqual([]);
  });

  it("da de alta una línea aunque sea agent, y la ve", async () => {
    const res = await como(CREADORA, "/v1/lines", {
      method: "POST", body: JSON.stringify({ name: "La mía", slug: "la-mia-alcance", channelKind: "sandbox" }),
    });
    expect(res.status).toBe(201);
    mia = (await j<{ data: { id: string } }>(res)).data.id;
    const { data } = await j<{ data: { id: string }[] }>(await como(CREADORA, "/v1/lines"));
    expect(data.map((l) => l.id)).toEqual([mia]);
    const yo = await j<{ data: { ownLines: string[]; canCreateLines: boolean } }>(await como(CREADORA, "/v1/auth/me"));
    expect(yo.data).toMatchObject({ ownLines: [mia], canCreateLines: true });
    // Y quien gestiona el equipo ve que esa línea es suya.
    const equipo = await j<{ data: { userId: string; ownLines: string[] }[] }>(await como(DUENO, "/v1/members"));
    expect(equipo.data.find((m) => m.userId === CREADORA)?.ownLines).toEqual([mia]);
  });

  it("la enlaza ella: ve su QR y lo conecta", async () => {
    const conectar = await como(CREADORA, `/v1/lines/${mia}/connect`, { method: "POST" });
    expect(conectar.status).toBe(200);
    const { data } = await j<{ data: { state: string; qr?: string } }>(await como(CREADORA, `/v1/lines/${mia}/status`));
    expect(data.state).toBe("awaiting-link");
    expect(data.qr).toBeTruthy();
    await conClave(`/v1/sandbox/lines/${mia}/scan`, { method: "POST", body: JSON.stringify({ phone: "51955500055" }) });
    await conClave(`/v1/sandbox/lines/${mia}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51966600066", text: "hola a la nueva" }),
    });
    await esperar(async () => {
      const r = await j<{ data: unknown[] }>(await como(CREADORA, `/v1/lines/${mia}/chats`));
      return r.data.length === 1;
    }, "le llegó el chat a su línea");
  });

  it("la configura, pero tu línea sigue cerrada para ella", async () => {
    const ajustar = await como(CREADORA, `/v1/lines/${mia}`, { method: "PATCH", body: JSON.stringify({ name: "Mía" }) });
    expect(ajustar.status).toBe(200);
    expect((await como(CREADORA, `/v1/lines/${L1}/status`)).status).toBe(401);
    expect((await como(CREADORA, `/v1/lines/${L1}/connect`, { method: "POST" })).status).toBe(401);
  });

  it("y la dueña la ve también, como todas las de la organización", async () => {
    const { data } = await j<{ data: { id: string }[] }>(await como(DUENO, "/v1/lines"));
    expect(data.map((l) => l.id)).toContain(mia);
  });

  it("con chats sueltos tuyos además, en la suya los ve todos", async () => {
    await como(DUENO, `/v1/members/${CREADORA}/scope`, {
      method: "PUT",
      body: JSON.stringify({ restricted: true, allowedLines: [L1], allowedChats: [A], canCreateLines: true }),
    });
    const tuyos = await j<{ data: { address: string }[] }>(await como(CREADORA, `/v1/lines/${L1}/chats`));
    expect(tuyos.data.map((c) => c.address)).toEqual([A]);
    const suyos = await j<{ data: unknown[] }>(await como(CREADORA, `/v1/lines/${mia}/chats`));
    expect(suyos.data).toHaveLength(1);
    const bandeja = await j<{ data: { lineId: string; chatId: string }[] }>(await como(CREADORA, "/v1/conversations"));
    expect(bandeja.data.map((c) => c.lineId).sort()).toEqual([L1, mia].sort());
  });

  it("sin el permiso de crear, una limitada no da de alta líneas", async () => {
    const res = await como(ACOTADA, "/v1/lines", {
      method: "POST", body: JSON.stringify({ name: "No", slug: "no-alcance", channelKind: "sandbox" }),
    });
    expect(res.status).toBe(403);
  });

  it("se puede invitar ya así: sin ninguna línea tuya y creando las suyas", async () => {
    const inv = await como(DUENO, "/v1/invitations", {
      method: "POST",
      body: JSON.stringify({ email: "crea-alcance@ejemplo.com", role: "agent", restricted: true, canCreateLines: true }),
    });
    expect(inv.status).toBe(201);
    const { data } = await j<{ data: { token: string; restricted: boolean; canCreateLines: boolean } }>(inv);
    expect(data).toMatchObject({ restricted: true, canCreateLines: true });
    const aceptada = await app.request("/v1/invitations/accept", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: data.token, name: "Crea", password: "una contraseña larga" }),
    });
    const cookie = (aceptada.headers.get("set-cookie") ?? "").split(";")[0]!;
    const lineas = await j<{ data: unknown[] }>(await app.request("/v1/lines", { headers: { cookie } }));
    expect(lineas.data).toEqual([]);
  });
});

