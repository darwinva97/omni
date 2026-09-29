import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiKeyTable, createDatabase, lineTable, migrate, orgTable, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey } from "../keys.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-plg";
const LINE = "line-plg";
let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let clave = "";
let dirPlugin = "";

const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;

/** Escribe un plugin en disco y devuelve su directorio. */
async function montarPlugin(manifiesto: Record<string, unknown>, codigo: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omni-plg-"));
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "package.json"), '{"type":"module"}', "utf8");
  await writeFile(join(dir, "manifest.json"), JSON.stringify({
    name: "Prueba", version: "1.0.0", main: "dist/index.js", ...manifiesto,
  }), "utf8");
  await writeFile(join(dir, "dist", "index.js"), codigo, "utf8");
  return dir;
}

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  await dbh.sql`DELETE FROM plugin WHERE org_id = ${ORG}`;
  for (const t of ["message", "chat", "auth_state"]) {
    await dbh.sql.unsafe(`DELETE FROM ${t} WHERE line_id = '${LINE}'`).catch(() => {});
  }
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.db.insert(orgTable).values({ id: ORG, name: "Plugins", slug: "plugins" });
  await dbh.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "L", slug: "l-plg", sendRatePerMinute: 6000,
  });
  const k = await mintApiKey();
  clave = k.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-plg", orgId: ORG, name: "admin", prefix: k.prefix, secretHash: k.secretHash, role: "admin",
  });

  dirPlugin = await montarPlugin(
    { id: "eco", permissions: ["messages:send", "kv:use"], hooks: ["message.received"] },
    `export default {
       async onHook(ctx, p) {
         await ctx.api.kvSet("ultimo", String(p.data?.text ?? ""));
         if (ctx.config.responder) {
           await ctx.api.enviarMensaje(p.lineId, p.data.key.remoteJid, "eco: " + p.data.text);
         }
       },
     };`,
  );

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "3".repeat(64),
      SANDBOX_ENABLED: "true", PLUGINS_ENABLED: "true", MEDIA_DIR: "./.data/test-media-plg",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

const llamar = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${clave}`, "content-type": "application/json", ...init.headers },
  });

const esperar = async (cond: () => Promise<boolean>, que: string, ms = 6000): Promise<void> => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`no se cumplió: ${que}`);
};

run("gestión de plugins", () => {
  it("instala leyendo el manifiesto, y nace APAGADO", async () => {
    // Instalar no es autorizar: un plugin que arrancara solo al instalarlo
    // convertiría copiar un directorio en ejecutar código.
    const res = await llamar("/v1/plugins", {
      method: "POST", body: JSON.stringify({ directory: dirPlugin }),
    });
    expect(res.status).toBe(201);
    const { data } = await j<{ data: { pluginId: string; enabled: boolean; permissions: string[] } }>(res);
    expect(data.pluginId).toBe("eco");
    expect(data.enabled).toBe(false);
    expect(data.permissions).toEqual(["messages:send", "kv:use"]);
  });

  it("no deja instalar dos veces el mismo", async () => {
    const res = await llamar("/v1/plugins", {
      method: "POST", body: JSON.stringify({ directory: dirPlugin }),
    });
    expect(res.status).toBe(409);
  });

  it("rechaza un manifiesto inválido antes de guardarlo", async () => {
    const malo = await montarPlugin({ id: "baileys" }, "export default {};");
    const res = await llamar("/v1/plugins", {
      method: "POST", body: JSON.stringify({ directory: malo }),
    });
    expect(res.status).toBe(422);
    expect((await j<{ detail: string }>(res)).detail).toContain("reservado");
  });

  it("rechaza un directorio sin manifiesto", async () => {
    const res = await llamar("/v1/plugins", {
      method: "POST", body: JSON.stringify({ directory: "/tmp/no-existe-nada-aqui" }),
    });
    expect(res.status).toBe(422);
  });

  it("habilitar lo arranca y responde a los eventos", async () => {
    expect((await llamar("/v1/plugins/eco/enable", {
      method: "POST", body: JSON.stringify({ enabled: true }),
    })).status).toBe(200);

    await llamar(`/v1/lines/${LINE}/connect`, { method: "POST" });
    await llamar(`/v1/sandbox/lines/${LINE}/scan`, {
      method: "POST", body: JSON.stringify({ phone: "51999888777" }),
    });
    await llamar(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51988777666", text: "hola plugin" }),
    });

    // El plugin guardó lo último que vio, con su prefijo y el de la organización.
    await esperar(
      async () => (await container.kv.get(`org:${ORG}:plugin:eco:ultimo`)) === "hola plugin",
      "el plugin recibió el evento",
    );
  });

  it("informa de su salud", async () => {
    const { data } = await j<{ data: { ok: boolean } }>(await llamar("/v1/plugins/eco/health"));
    expect(data.ok).toBe(true);
  });

  it("la configuración entra sin reiniciarlo", async () => {
    // El plugin la relee en cada gancho, así que no hace falta pararlo.
    expect((await llamar("/v1/plugins/eco/config", {
      method: "PUT", body: JSON.stringify({ config: { responder: true } }),
    })).status).toBe(200);

    await llamar(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51988777666", text: "responde" }),
    });

    await esperar(async () => {
      const filas = await dbh.sql`
        SELECT body FROM message WHERE line_id = ${LINE} AND from_me = true`;
      return filas.some((f) => String(f["body"]).includes("eco: responde"));
    }, "el plugin respondió usando la configuración nueva");
  });

  it("un plugin que pide más de lo declarado falla al usarlo", async () => {
    const codicioso = await montarPlugin(
      { id: "codicioso", permissions: ["kv:use"], hooks: ["message.received"] },
      `export default {
         async onHook(ctx, p) {
           try { await ctx.api.enviarMensaje(p.lineId, "51900000000", "no debería"); }
           catch (e) { await ctx.api.kvSet("denegado", e.message); }
         },
       };`,
    );
    await llamar("/v1/plugins", { method: "POST", body: JSON.stringify({ directory: codicioso }) });
    await llamar("/v1/plugins/codicioso/enable", { method: "POST", body: JSON.stringify({ enabled: true }) });

    await llamar(`/v1/sandbox/lines/${LINE}/inbound`, {
      method: "POST", body: JSON.stringify({ from: "51988777666", text: "prueba" }),
    });
    await esperar(async () => {
      const v = await container.kv.get(`org:${ORG}:plugin:codicioso:denegado`);
      return v !== null && v.includes("messages:send");
    }, "la capacidad no declarada se denegó");
  });

  it("deshabilitar lo detiene", async () => {
    expect((await llamar("/v1/plugins/eco/enable", {
      method: "POST", body: JSON.stringify({ enabled: false }),
    })).status).toBe(200);
    const { data } = await j<{ data: { ok: boolean } }>(await llamar("/v1/plugins/eco/health"));
    expect(data.ok).toBe(false);
  });

  it("desinstalar lo quita de la lista", async () => {
    expect((await llamar("/v1/plugins/eco", { method: "DELETE" })).status).toBe(200);
    const { data } = await j<{ data: { pluginId: string }[] }>(await llamar("/v1/plugins"));
    expect(data.map((p) => p.pluginId)).not.toContain("eco");
  });
});
