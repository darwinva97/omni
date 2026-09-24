import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { apiKeyTable, createDatabase, lineTable, migrate, orgTable, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey } from "../keys.js";

const URL = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL ? describe : describe.skip;

const ORG = "org-mcp";
const LINE = "line-mcp";
let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let adminKey: string;
let scopedKey: string;

beforeAll(async () => {
  if (!URL) return;
  await migrate(URL);
  dbh = createDatabase(URL);
  await dbh.sql`DELETE FROM message WHERE line_id = ${LINE}`;
  await dbh.sql`DELETE FROM chat WHERE line_id = ${LINE}`;
  await dbh.sql`DELETE FROM auth_state WHERE line_id = ${LINE}`;
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE id = ${LINE}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.db.insert(orgTable).values({ id: ORG, name: "MCP", slug: "mcp" });
  await dbh.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "Línea", slug: "linea",
    address: "51999888777@s.whatsapp.net", sendRatePerMinute: 6000,
  });

  const admin = await mintApiKey();
  adminKey = admin.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-mcp-admin", orgId: ORG, name: "admin", prefix: admin.prefix,
    secretHash: admin.secretHash, role: "admin",
  });

  const scoped = await mintApiKey();
  scopedKey = scoped.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-mcp-scoped", orgId: ORG, name: "agente", prefix: scoped.prefix,
    secretHash: scoped.secretHash, role: "operator",
    allowedLines: [LINE], allowedChats: ["51988777666@s.whatsapp.net"],
  });

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL, OMNI_MASTER_KEY: "d".repeat(64),
      SANDBOX_ENABLED: "true", MCP_ENABLED: "true", MCP_READONLY: "false",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);
});

afterAll(async () => {
  await container?.shutdown();
  await dbh?.close();
});

let id = 0;
async function mcp(method: string, params: unknown, key: string): Promise<Record<string, unknown>> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  if (res.status === 202) return {};
  return (await res.json()) as Record<string, unknown>;
}

const init = (key: string) =>
  mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "prueba", version: "1" },
  }, key);

run("servidor MCP", () => {
  it("negocia la conexión y se presenta", async () => {
    const r = await init(adminKey);
    const result = r["result"] as { serverInfo: { name: string }; instructions?: string };
    expect(result.serverInfo.name).toBe("omni");
    // Las instrucciones avisan de que el envío queda encolado, no entregado.
    expect(result.instructions).toMatch(/ENCOLADOS/);
  });

  it("rechaza sin credencial", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("publica las herramientas con su descripción", async () => {
    await init(adminKey);
    const r = await mcp("tools/list", {}, adminKey);
    const tools = (r["result"] as { tools: { name: string }[] }).tools;
    const nombres = tools.map((t) => t.name);
    expect(nombres).toContain("listar_lineas");
    expect(nombres).toContain("enviar_mensaje");
    expect(nombres).toContain("capacidades");
  });

  it("una herramienta de lectura devuelve datos reales", async () => {
    await init(adminKey);
    const r = await mcp("tools/call", { name: "listar_lineas", arguments: {} }, adminKey);
    const content = (r["result"] as { content: { text: string }[] }).content;
    const lineas = JSON.parse(content[0]!.text) as { id: string }[];
    expect(lineas.map((l) => l.id)).toContain(LINE);
  });

  it("el alcance se comprueba EN CADA LLAMADA, no solo al conectar", async () => {
    // Es el punto que OpenWA documenta: una superficie fuera del guard REST no
    // hereda sus permisos. Si esto fallara, un agente acotado escribiría a
    // cualquiera con solo hablar por MCP en vez de por HTTP.
    await init(scopedKey);

    const permitido = await mcp("tools/call", {
      name: "enviar_mensaje",
      arguments: { lineId: LINE, to: "51988777666", text: "dentro del alcance" },
    }, scopedKey);
    expect((permitido["result"] as { isError?: boolean }).isError).toBeUndefined();

    const fuera = await mcp("tools/call", {
      name: "enviar_mensaje",
      arguments: { lineId: LINE, to: "51900000000", text: "fuera del alcance" },
    }, scopedKey);
    const res = fuera["result"] as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("forbidden");
  });

  it("una línea fuera de alcance tampoco se alcanza por MCP", async () => {
    await init(scopedKey);
    const r = await mcp("tools/call", {
      name: "listar_chats", arguments: { lineId: "otra-linea" },
    }, scopedKey);
    const res = r["result"] as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("unauthenticated");
  });

  it("en modo solo lectura no se ofrecen herramientas de escritura", async () => {
    const soloLectura = await buildContainer(
      loadConfig({
        ...process.env, DATABASE_URL: URL!, OMNI_MASTER_KEY: "d".repeat(64),
        SANDBOX_ENABLED: "true", MCP_ENABLED: "true", MCP_READONLY: "true",
      } as NodeJS.ProcessEnv),
      { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
    );
    const appRO = createApp(soloLectura);
    const call = async (method: string, params: unknown) => {
      const res = await appRO.request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminKey}`, "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      return (await res.json()) as Record<string, unknown>;
    };
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "p", version: "1" } });
    const r = await call("tools/list", {});
    const nombres = (r["result"] as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(nombres).toContain("listar_lineas");
    expect(nombres).not.toContain("enviar_mensaje");
    await soloLectura.shutdown();
  });

  it("no está montado si MCP_ENABLED es falso", async () => {
    const apagado = await buildContainer(
      loadConfig({
        ...process.env, DATABASE_URL: URL!, OMNI_MASTER_KEY: "d".repeat(64), MCP_ENABLED: "false",
      } as NodeJS.ProcessEnv),
      { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
    );
    const res = await createApp(apagado).request("/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    await apagado.shutdown();
  });
});
