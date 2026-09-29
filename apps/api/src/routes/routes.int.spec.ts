import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseAddress } from "@omni/shared";
import { apiKeyTable, createDatabase, lineTable, migrate, orgTable, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey } from "../keys.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-rutas";
const LINE = "line-rutas";
const CHAT = "51988777666@s.whatsapp.net";

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let adminKey: string;
let scopedKey: string;

const j = async <T>(res: Response): Promise<T> => (await res.json()) as T;

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  for (const t of ["message", "chat", "auth_state", "group_participant", "group_info", "contact"]) {
    await dbh.sql.unsafe(`DELETE FROM ${t} WHERE line_id = '${LINE}'`).catch(() => {});
  }
  await dbh.sql`DELETE FROM audit_event WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.sql`DELETE FROM omni_kv WHERE key LIKE ${'idem:' + LINE + ':%'}`.catch(() => {});
  await dbh.db.insert(orgTable).values({ id: ORG, name: "Rutas", slug: "rutas" });
  await dbh.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "L", slug: "l",
    address: "51999888777@s.whatsapp.net", sendRatePerMinute: 6000,
  });

  const a = await mintApiKey();
  adminKey = a.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-rutas-admin", orgId: ORG, name: "admin", prefix: a.prefix, secretHash: a.secretHash, role: "admin",
  });
  const s = await mintApiKey();
  scopedKey = s.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-rutas-chat", orgId: ORG, name: "agente", prefix: s.prefix, secretHash: s.secretHash,
    role: "operator", allowedLines: [LINE], allowedChats: [CHAT],
  });

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "b".repeat(64),
      SANDBOX_ENABLED: "true", MEDIA_DIR: "./.data/test-media-rutas",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);

  await call(`/v1/lines/${LINE}/connect`, { method: "POST" });
  await call(`/v1/sandbox/lines/${LINE}/scan`, { method: "POST", body: JSON.stringify({ phone: "51999888777" }) });
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

async function call(path: string, init: RequestInit = {}, key = adminKey): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...init.headers },
  });
}

const enc = encodeURIComponent;

run("rutas de mensajes y chats", () => {
  let providerId: string;

  it("envía y luego edita el mensaje", async () => {
    const sent = await j<{ data: { clientMessageId: string } }>(
      await call(`/v1/lines/${LINE}/messages`, {
        method: "POST", body: JSON.stringify({ to: CHAT, text: "original", clientMessageId: "r-1" }),
      }),
    );
    expect(sent.data.clientMessageId).toBe("r-1");
    providerId = `SBX-r-1`;

    await new Promise((r) => setTimeout(r, 400));
    const res = await call(`/v1/lines/${LINE}/chats/${enc(CHAT)}/messages/${providerId}`, {
      method: "PATCH", body: JSON.stringify({ text: "corregido" }),
    });
    expect(res.status).toBe(200);
  });

  it("reacciona y marca como leído", async () => {
    expect((await call(`/v1/lines/${LINE}/chats/${enc(CHAT)}/messages/${providerId}/reaction`, {
      method: "POST", body: JSON.stringify({ emoji: "👍" }),
    })).status).toBe(200);

    expect((await call(`/v1/lines/${LINE}/chats/${enc(CHAT)}/read`, {
      method: "POST", body: JSON.stringify({ messageIds: [providerId] }),
    })).status).toBe(200);
  });

  it("anuncia que se está escribiendo", async () => {
    const res = await call(`/v1/lines/${LINE}/chats/${enc(CHAT)}/presence`, {
      method: "POST", body: JSON.stringify({ presence: "composing" }),
    });
    expect(res.status).toBe(200);
  });

  it("borra el mensaje y lo marca, sin perder la fila", async () => {
    expect((await call(`/v1/lines/${LINE}/chats/${enc(CHAT)}/messages/${providerId}`, {
      method: "DELETE",
    })).status).toBe(200);
    const rows = await dbh.sql`
      SELECT deleted_at FROM message WHERE line_id = ${LINE} AND provider_message_id = ${providerId}`;
    expect(rows[0]!["deleted_at"]).not.toBeNull();
  });

  it("una clave acotada puede actuar en su chat pero no en otro", async () => {
    const dentro = await call(`/v1/lines/${LINE}/chats/${enc(CHAT)}/presence`, {
      method: "POST", body: JSON.stringify({ presence: "paused" }),
    }, scopedKey);
    expect(dentro.status).toBe(200);

    const fuera = await call(`/v1/lines/${LINE}/chats/${enc("51900000000@s.whatsapp.net")}/presence`, {
      method: "POST", body: JSON.stringify({ presence: "paused" }),
    }, scopedKey);
    expect(fuera.status).toBe(403);
  });
});

run("contactos", () => {
  it("comprueba si un número existe", async () => {
    const res = await call(`/v1/lines/${LINE}/contacts/${enc("51999000111@s.whatsapp.net")}/exists`);
    expect(res.status).toBe(200);
    expect((await j<{ data: { exists: boolean } }>(res)).data.exists).toBe(true);
  });

  it("bloquea y aparece en la lista", async () => {
    expect((await call(`/v1/lines/${LINE}/contacts/${enc(CHAT)}/block`, {
      method: "POST", body: JSON.stringify({ blocked: true }),
    })).status).toBe(200);

    const lista = await j<{ data: { address: string; blocked: boolean }[] }>(
      await call(`/v1/lines/${LINE}/contacts`),
    );
    expect(lista.data.find((c) => c.address === CHAT)?.blocked).toBe(true);
  });
});

run("grupos", () => {
  let grupo: string;

  it("crea un grupo con sus participantes", async () => {
    const res = await call(`/v1/lines/${LINE}/groups`, {
      method: "POST", body: JSON.stringify({ subject: "Equipo", participants: ["51988777666"] }),
    });
    expect(res.status).toBe(201);
    const { data } = await j<{ data: { address: string; participants: { role: string }[] } }>(res);
    grupo = data.address;
    expect(data.participants).toHaveLength(2);
    expect(data.participants[0]!.role).toBe("superadmin");
  });

  it("lee el grupo y lo refleja en la base", async () => {
    const res = await call(`/v1/lines/${LINE}/groups/${enc(grupo)}`);
    expect(res.status).toBe(200);
    const filas = await dbh.sql`SELECT subject, size FROM group_info WHERE line_id = ${LINE}`;
    expect(filas[0]!["subject"]).toBe("Equipo");
    expect(Number(filas[0]!["size"])).toBe(2);
  });

  it("informa por participante en vez de un sí o no global", async () => {
    const res = await call(`/v1/lines/${LINE}/groups/${enc(grupo)}/participants`, {
      method: "POST",
      body: JSON.stringify({ action: "add", participants: ["51988777666", "51900000000"] }),
    });
    const { data } = await j<{ data: { ok: boolean; reason?: string }[] }>(res);
    expect(data[0]).toMatchObject({ ok: false, reason: "ya es miembro" });
    expect(data[1]).toMatchObject({ ok: true });
  });

  it("una clave acotada al grupo NO puede tocar quién pertenece", async () => {
    // Puede trabajar en el grupo; decidir sus miembros es otra cosa.
    const s = await mintApiKey();
    await dbh.db.insert(apiKeyTable).values({
      id: "k-rutas-grupo", orgId: ORG, name: "agente grupo", prefix: s.prefix,
      secretHash: s.secretHash, role: "operator", allowedLines: [LINE], allowedChats: [grupo],
    });
    const res = await call(`/v1/lines/${LINE}/groups/${enc(grupo)}/participants`, {
      method: "POST", body: JSON.stringify({ action: "remove", participants: ["51900000000"] }),
    }, s.plaintext);
    expect(res.status).toBe(403);
  });

  it("cambiar el asunto llega al transporte, no solo a nuestro espejo", async () => {
    const res = await call(`/v1/lines/${LINE}/groups/${enc(grupo)}`, {
      method: "PATCH", body: JSON.stringify({ subject: "Equipo nuevo", description: "otra cosa" }),
    });
    expect(res.status).toBe(200);

    // Lo que cuenta es lo que ve el transporte: escribir solo en nuestra tabla
    // enseñaría un asunto que el grupo real no tiene.
    const meta = await container.sandbox!.groupMetadata(LINE as never, parseAddress(grupo));
    expect(meta.subject).toBe("Equipo nuevo");
    expect(meta.description).toBe("otra cosa");

    const filas = await dbh.sql`SELECT subject FROM group_info WHERE address = ${grupo}`;
    expect(filas[0]?.["subject"]).toBe("Equipo nuevo");
  });

  it("da el código de invitación y lo rota cuando se pide", async () => {
    const primero = await j<{ data: { code: string; url: string } }>(
      await call(`/v1/lines/${LINE}/groups/${enc(grupo)}/invite`));
    expect(primero.data.code).toBeTruthy();
    expect(primero.data.url).toContain(primero.data.code);

    // Leerlo dos veces da el mismo: leer no es rotar.
    const otra = await j<{ data: { code: string } }>(
      await call(`/v1/lines/${LINE}/groups/${enc(grupo)}/invite`));
    expect(otra.data.code).toBe(primero.data.code);

    const rotado = await j<{ data: { code: string } }>(
      await call(`/v1/lines/${LINE}/groups/${enc(grupo)}/invite`, { method: "POST" }));
    expect(rotado.data.code).not.toBe(primero.data.code);
  });

  it("salir del grupo lo hace en el transporte y luego lo olvida", async () => {
    const res = await call(`/v1/lines/${LINE}/groups/${enc(grupo)}/leave`, { method: "POST" });
    expect(res.status).toBe(200);

    await expect(
      container.sandbox!.groupMetadata(LINE as never, parseAddress(grupo)),
    ).rejects.toThrow();

    const filas = await dbh.sql`SELECT 1 FROM group_info WHERE address = ${grupo}`;
    expect(filas).toHaveLength(0);
  });
});

run("administración de líneas y credenciales", () => {
  it("crea una línea y rechaza el identificador repetido", async () => {
    const res = await call("/v1/lines", {
      method: "POST",
      body: JSON.stringify({ name: "Otra", slug: "otra", channelKind: "sandbox", sendRatePerMinute: 30 }),
    });
    expect(res.status).toBe(201);
    const repetida = await call("/v1/lines", {
      method: "POST", body: JSON.stringify({ name: "Otra", slug: "otra", channelKind: "sandbox" }),
    });
    expect(repetida.status).toBe(409);
  });

  it("cambia el ritmo de envío de una línea", async () => {
    const res = await call(`/v1/lines/${LINE}`, {
      method: "PATCH", body: JSON.stringify({ sendRatePerMinute: 20 }),
    });
    expect((await j<{ data: { sendRatePerMinute: number } }>(res)).data.sendRatePerMinute).toBe(20);
    await call(`/v1/lines/${LINE}`, { method: "PATCH", body: JSON.stringify({ sendRatePerMinute: 6000 }) });
  });

  it("acuña una clave, la enseña una vez y luego solo su prefijo", async () => {
    const res = await call("/v1/api-keys", {
      method: "POST",
      body: JSON.stringify({ name: "integración", role: "operator", allowedChats: [CHAT] }),
    });
    expect(res.status).toBe(201);
    const { data } = await j<{ data: { apiKey: string; id: string; prefix: string } }>(res);
    expect(data.apiKey).toMatch(/^omni_[0-9a-f]+_/);

    const lista = await j<{ data: { id: string; prefix: string }[] }>(await call("/v1/api-keys"));
    const guardada = lista.data.find((k) => k.id === data.id)!;
    expect(guardada.prefix).toBe(data.prefix);
    expect(JSON.stringify(guardada)).not.toContain(data.apiKey.split("_")[2]!);
  });

  it("no deja revocar la última clave de administración viva", async () => {
    const res = await call("/v1/api-keys/k-rutas-admin", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await j<{ detail: string }>(res)).detail).toMatch(/última clave de administración/);
  });

  it("la bitácora registra lo que se ha hecho", async () => {
    const res = await call("/v1/audit");
    const { data } = await j<{ data: { action: string }[] }>(res);
    expect(data.map((e) => e.action)).toContain("line.create");
    expect(data.map((e) => e.action)).toContain("apikey.create");
  });

  it("una clave acotada a chats no llega a la administración", async () => {
    expect((await call("/v1/api-keys", {}, scopedKey)).status).toBe(403);
    expect((await call("/v1/audit", {}, scopedKey)).status).toBe(403);
  });
});
