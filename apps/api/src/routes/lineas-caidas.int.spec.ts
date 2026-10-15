import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiKeyTable, createDatabase, lineTable, migrate, orgTable, type DbHandle } from "@omni/db";
import type { EventEnvelope } from "@omni/shared";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey } from "../keys.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-caidas";
const LINE = "line-caidas";

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let clave = "";

const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;
const llamar = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${clave}`, "content-type": "application/json", ...init.headers },
  });

/** El estado que enseña la lista de líneas: el que lee el panel al cargar. */
const estadoEnLaLista = async (): Promise<string> => {
  const { data } = await j<{ data: { id: string; status: string }[] }>(await llamar("/v1/lines"));
  return data.find((l) => l.id === LINE)!.status;
};

const esperar = async (cond: () => Promise<boolean>, que: string, ms = 5000): Promise<void> => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`no se cumplió: ${que}`);
};

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  await dbh.sql`DELETE FROM auth_state WHERE line_id = ${LINE}`;
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.db.insert(orgTable).values({ id: ORG, name: "Caídas", slug: "caidas" });
  await dbh.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "Ventas", slug: "ventas-caidas",
  });
  const k = await mintApiKey();
  clave = k.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-caidas", orgId: ORG, name: "admin", prefix: k.prefix, secretHash: k.secretHash, role: "admin",
  });
  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "c".repeat(64),
      SANDBOX_ENABLED: "true", MEDIA_DIR: "./.data/test-media-caidas",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);
  await llamar(`/v1/lines/${LINE}/connect`, { method: "POST" });
  await llamar(`/v1/sandbox/lines/${LINE}/scan`, {
    method: "POST", body: JSON.stringify({ phone: "51944555666" }),
  });
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

run("una línea que se cae", () => {
  it("una caída que nadie pidió sale en vivo y queda apuntada en la línea", async () => {
    expect(await estadoEnLaLista()).toBe("connected");

    const eventos: EventEnvelope[] = [];
    const off = await container.bus.subscribe<EventEnvelope>(`org:${ORG}`, (e) => {
      if (e.event.startsWith("session.")) eventos.push(e);
    });
    try {
      const res = await llamar(`/v1/sandbox/lines/${LINE}/drop`, { method: "POST", body: "{}" });
      expect(res.status).toBe(200);
      await esperar(async () => eventos.some((e) => e.event === "session.disconnected"),
        "llegó la caída por el bus");
    } finally {
      await off();
    }
    // Antes se quedaba «connected» en la base: solo `session.status` la
    // cambiaba, y una caída de Baileys no lo emite.
    await esperar(async () => (await estadoEnLaLista()) === "disconnected", "la línea dice desconectada");
  });

  it("reconectar con la sesión guardada no pide QR", async () => {
    const { data } = await j<{ data: { state: string } }>(
      await llamar(`/v1/lines/${LINE}/connect`, { method: "POST" }));
    expect(data.state).toBe("connected");
    await esperar(async () => (await estadoEnLaLista()) === "connected", "vuelve a conectada");
  });

  it("si desvinculan el dispositivo, queda sin sesión y hay que volver a enlazar", async () => {
    await llamar(`/v1/sandbox/lines/${LINE}/drop`, {
      method: "POST", body: JSON.stringify({ loggedOut: true }),
    });
    await esperar(async () => (await estadoEnLaLista()) === "logged-out", "la línea dice sin sesión");

    const { data } = await j<{ data: { state: string; qr?: string } }>(
      await llamar(`/v1/lines/${LINE}/connect`, { method: "POST" }));
    expect(data.state).toBe("awaiting-link");
    expect(data.qr).toBeTruthy();
  });
});
