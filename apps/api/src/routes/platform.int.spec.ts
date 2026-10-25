import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabase, migrate, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";

/*
 * Aprovisionamiento por plataforma (`/platform/*`) y aislamiento entre las
 * organizaciones que crea: una clave de una organización no alcanza las líneas
 * de otra, ni por REST ni por MCP, aunque conozca su id.
 */
const URL = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL ? describe : describe.skip;
const TOKEN = "t".repeat(48);

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  if (!URL) return;
  await migrate(URL);
  dbh = createDatabase(URL);
  for (const slug of ["ext-plat-a", "ext-plat-b"]) {
    await dbh.sql`UPDATE line SET deleted_at = now() WHERE org_id IN (SELECT id FROM org WHERE slug = ${slug})`;
  }
  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL, OMNI_MASTER_KEY: "d".repeat(64), OMNI_PLATFORM_TOKEN: TOKEN,
      SANDBOX_ENABLED: "true", MCP_ENABLED: "true", MCP_READONLY: "true",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);
});

afterAll(async () => {
  if (!URL) return;
  await container?.shutdown();
  await dbh?.close();
});

const plataforma = (ruta: string, init: RequestInit = {}, token = TOKEN) =>
  app.request(ruta, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
type Org = { data: { orgId: string; apiKey: string } };
const leer = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const conClave = (clave: string) => (ruta: string, init: RequestInit = {}) =>
  app.request(ruta, { ...init, headers: { authorization: `Bearer ${clave}`, "content-type": "application/json", ...(init.headers ?? {}) } });

run("aprovisionamiento por plataforma", () => {
  it("sin token o con uno falso, nada", async () => {
    expect((await app.request("/platform/ping")).status).toBe(401);
    expect((await plataforma("/platform/ping", {}, "x".repeat(48))).status).toBe(401);
    expect((await plataforma("/platform/ping")).status).toBe(200);
  });

  it("crea la organización, da una clave y la rota sin duplicar la organización", async () => {
    const crear = () => plataforma("/platform/orgs", { method: "POST", body: JSON.stringify({ externalId: "plat-a", name: "A" }) });
    const r1 = await leer<Org>(crear());
    const r2 = await leer<Org>(crear());
    expect(r2.data.orgId).toBe(r1.data.orgId);
    expect((await conClave(r1.data.apiKey)("/v1/org")).status).toBe(401);
    expect((await conClave(r2.data.apiKey)("/v1/org")).status).toBe(200);
    expect((await plataforma("/platform/orgs", { method: "POST", body: JSON.stringify({ externalId: "../x", name: "x" }) })).status).toBe(422);
  });

  it("una organización no alcanza las líneas de otra, ni por REST ni por MCP", async () => {
    const a = (await leer<Org>(plataforma("/platform/orgs", { method: "POST", body: JSON.stringify({ externalId: "plat-a", name: "A" }) }))).data.apiKey;
    const b = (await leer<Org>(plataforma("/platform/orgs", { method: "POST", body: JSON.stringify({ externalId: "plat-b", name: "B" }) }))).data.apiKey;
    const linea = (await leer<{ data: { id: string } }>(conClave(a)("/v1/lines", {
      method: "POST", body: JSON.stringify({ name: "A", slug: `a-${Date.now()}`, channelKind: "sandbox" }),
    }))).data.id;

    expect((await conClave(a)(`/v1/lines/${linea}/chats`)).status).toBe(200);
    for (const [metodo, ruta, cuerpo] of [
      ["GET", `/v1/lines/${linea}/chats`, undefined],
      ["GET", `/v1/lines/${linea}/status`, undefined],
      ["POST", `/v1/lines/${linea}/connect`, undefined],
      ["POST", `/v1/lines/${linea}/messages`, { to: "51988777666", text: "hola" }],
      ["DELETE", `/v1/lines/${linea}`, undefined],
      ["POST", `/v1/sandbox/lines/${linea}/inbound`, { from: "51988777666", text: "hola" }],
    ] as const) {
      const r = await conClave(b)(ruta, { method: metodo, ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}) });
      expect(r.status, `${metodo} ${ruta}`).toBe(401);
    }

    const mcp = await leer<{ result: { isError?: boolean } }>(conClave(b)("/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "listar_chats", arguments: { lineId: linea } } }),
    }));
    expect(mcp.result.isError).toBe(true);
  });

  it("la baja revoca las claves", async () => {
    const a = (await leer<Org>(plataforma("/platform/orgs", { method: "POST", body: JSON.stringify({ externalId: "plat-b", name: "B" }) }))).data.apiKey;
    expect((await plataforma("/platform/orgs/plat-b", { method: "DELETE" })).status).toBe(200);
    expect((await conClave(a)("/v1/lines")).status).toBe(401);
  });
});
