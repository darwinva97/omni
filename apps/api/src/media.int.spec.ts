import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiKeyTable, createDatabase, lineTable, migrate, messageTable, orgTable, type DbHandle } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { loadConfig } from "./config.js";
import { buildContainer, type Container } from "./container.js";
import { createApp } from "./app.js";
import { mintApiKey } from "./keys.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-media";
const LINE = "line-media";
let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let key: string;

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  for (const t of ["message", "chat", "auth_state"]) {
    await dbh.sql.unsafe(`DELETE FROM ${t} WHERE line_id = '${LINE}'`).catch(() => {});
  }
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM omni_kv WHERE key LIKE ${'idem:' + LINE + ':%'}`.catch(() => {});
  await dbh.sql`DELETE FROM line WHERE id = ${LINE}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.db.insert(orgTable).values({ id: ORG, name: "Media", slug: "media" });
  await dbh.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "L", slug: "l",
    address: "51999888777@s.whatsapp.net", sendRatePerMinute: 6000,
  });
  const k = await mintApiKey();
  key = k.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-media", orgId: ORG, name: "m", prefix: k.prefix, secretHash: k.secretHash, role: "admin",
  });

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "c".repeat(64),
      SANDBOX_ENABLED: "true", MEDIA_DIR: "./.data/test-media",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

const call = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { authorization: `Bearer ${key}`, ...init.headers } });

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

run("medios", () => {
  it("sube un fichero y devuelve su clave", async () => {
    const form = new FormData();
    form.set("lineId", LINE);
    form.set("file", new File([new Uint8Array([137, 80, 78, 71])], "foto.png", { type: "image/png" }));
    const res = await call("/v1/media", { method: "POST", body: form });
    expect(res.status).toBe(201);
    const { data } = await json<{ data: { storageKey: string; size: number; mimeType: string } }>(res);
    expect(data.size).toBe(4);
    expect(data.mimeType).toBe("image/png");
    expect(await container.storage.exists(data.storageKey)).toBe(true);
  });

  it("envía una imagen desde una clave ya subida y la persiste", async () => {
    const form = new FormData();
    form.set("lineId", LINE);
    form.set("file", new File([new Uint8Array([1, 2, 3, 4, 5])], "gato.png", { type: "image/png" }));
    const up = await json<{ data: { storageKey: string } }>(
      await call("/v1/media", { method: "POST", body: form }),
    );

    await call(`/v1/lines/${LINE}/connect`, { method: "POST" });
    await call(`/v1/sandbox/lines/${LINE}/scan`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "51999888777" }),
    });

    const res = await call(`/v1/lines/${LINE}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: "51988777666", image: { storageKey: up.data.storageKey },
        caption: "mira esto", clientMessageId: "media-1",
      }),
    });
    expect(res.status).toBe(202);

    const rows = await dbh.db.select().from(messageTable)
      .where(and(eq(messageTable.lineId, LINE), eq(messageTable.clientMessageId, "media-1")));
    expect(rows[0]!.kind).toBe("image");
    expect(rows[0]!.mediaKey).toBe(up.data.storageKey);
    expect(rows[0]!.mediaMime).toBe("image/png");
    expect(rows[0]!.body).toBe("mira esto");
  });

  it("una URL hacia la red interna se rechaza antes de descargarla", async () => {
    // El servidor no puede convertirse en puente hacia su propia red.
    const res = await call(`/v1/lines/${LINE}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "51988777666", image: { url: "http://169.254.169.254/latest/meta-data/" } }),
    });
    expect(res.status).toBe(422);
    expect((await json<{ detail: string }>(res)).detail).toMatch(/internas/);
  });

  it("una clave de medio inexistente da 404 y no encola nada", async () => {
    const res = await call(`/v1/lines/${LINE}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "51988777666", document: { storageKey: "media/no/existe" } }),
    });
    expect(res.status).toBe(404);
  });

  it("sirve el medio solo con una firma válida y vigente", async () => {
    const form = new FormData();
    form.set("lineId", LINE);
    form.set("file", new File([new TextEncoder().encode("contenido")], "n.txt", { type: "text/plain" }));
    const up = await json<{ data: { storageKey: string } }>(
      await call("/v1/media", { method: "POST", body: form }),
    );
    const url = await container.storage.signedUrl(up.data.storageKey, 300);

    const ok = await app.request(url);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("contenido");

    // Sin firma, y con una firma inventada, no se sirve nada.
    const desnuda = await app.request(url.split("?")[0]!);
    expect(desnuda.status).toBe(403);
    const falsa = await app.request(url.replace(/signature=[0-9a-f]+/, "signature=" + "0".repeat(64)));
    expect(falsa.status).toBe(403);
  });
});
