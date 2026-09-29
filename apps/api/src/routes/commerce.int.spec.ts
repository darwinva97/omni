import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiKeyTable, createDatabase, lineTable, migrate, orgTable, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey } from "../keys.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-com";
const LINE = "line-com";

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let clave = "";

const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;
const enc = encodeURIComponent;

const llamar = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${clave}`, "content-type": "application/json", ...init.headers },
  });

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  await dbh.sql`DELETE FROM conversation WHERE org_id = ${ORG}`;
  for (const t of ["message", "chat", "auth_state", "group_participant", "group_info"]) {
    await dbh.sql.unsafe(`DELETE FROM ${t} WHERE line_id = '${LINE}'`).catch(() => {});
  }
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.db.insert(orgTable).values({ id: ORG, name: "Comercio", slug: "comercio" });
  await dbh.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "L", slug: "l-com",
    address: "51999888777@s.whatsapp.net", sendRatePerMinute: 6000,
  });
  const k = await mintApiKey();
  clave = k.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-com", orgId: ORG, name: "admin", prefix: k.prefix, secretHash: k.secretHash, role: "admin",
  });

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "9".repeat(64),
      SANDBOX_ENABLED: "true", MEDIA_DIR: "./.data/test-media-com",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);
  await llamar(`/v1/lines/${LINE}/connect`, { method: "POST" });
  await llamar(`/v1/sandbox/lines/${LINE}/scan`, {
    method: "POST", body: JSON.stringify({ phone: "51999888777" }),
  });
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

run("comunidades", () => {
  let comunidad: string;
  let grupo: string;

  it("crea una comunidad, vacía de grupos", async () => {
    const res = await llamar(`/v1/lines/${LINE}/communities`, {
      method: "POST",
      body: JSON.stringify({ subject: "Vecinos", description: "del barrio" }),
    });
    expect(res.status).toBe(201);
    const { data } = await j<{ data: { address: string; subject: string; linkedGroups: unknown[] } }>(res);
    expect(data.subject).toBe("Vecinos");
    // Vacío significa "ninguno", no "no lo sabemos": quien no pueda
    // enumerarlos no debe declarar la capacidad.
    expect(data.linkedGroups).toEqual([]);
    comunidad = data.address;
  });

  it("enlaza un grupo, y enlazarlo dos veces no lo duplica", async () => {
    const creado = await j<{ data: { address: string } }>(
      await llamar(`/v1/lines/${LINE}/groups`, {
        method: "POST",
        body: JSON.stringify({ subject: "Escalera A", participants: ["51988777666"] }),
      }));
    grupo = creado.data.address;

    for (let i = 0; i < 2; i++) {
      const res = await llamar(`/v1/lines/${LINE}/communities/${enc(comunidad)}/groups`, {
        method: "POST", body: JSON.stringify({ groupId: grupo, linked: true }),
      });
      expect(res.status).toBe(200);
    }

    const { data } = await j<{ data: { linkedGroups: { address: string; subject: string }[] } }>(
      await llamar(`/v1/lines/${LINE}/communities/${enc(comunidad)}`));
    expect(data.linkedGroups).toHaveLength(1);
    expect(data.linkedGroups[0]!.subject).toBe("Escalera A");
  });

  it("desenlazar deja el grupo en pie", async () => {
    await llamar(`/v1/lines/${LINE}/communities/${enc(comunidad)}/groups`, {
      method: "POST", body: JSON.stringify({ groupId: grupo, linked: false }),
    });
    const { data } = await j<{ data: { linkedGroups: unknown[] } }>(
      await llamar(`/v1/lines/${LINE}/communities/${enc(comunidad)}`));
    expect(data.linkedGroups).toEqual([]);

    // El grupo sigue existiendo: desenlazar no es disolver.
    const grupoRes = await llamar(`/v1/lines/${LINE}/groups/${enc(grupo)}`);
    expect(grupoRes.status).toBe(200);
  });

  it("una comunidad que no existe es 404", async () => {
    const res = await llamar(`/v1/lines/${LINE}/communities/${enc("999999@g.us")}`);
    expect(res.status).toBe(404);
  });

  it("salir la quita de la lista", async () => {
    expect((await llamar(`/v1/lines/${LINE}/communities/${enc(comunidad)}/leave`, {
      method: "POST",
    })).status).toBe(200);
    const { data } = await j<{ data: { address: string }[] }>(
      await llamar(`/v1/lines/${LINE}/communities`));
    expect(data.map((c) => c.address)).not.toContain(comunidad);
  });
});

run("catálogo", () => {
  let producto: string;

  it("publica un producto y nace PENDIENTE de revisión", async () => {
    const res = await llamar(`/v1/lines/${LINE}/products`, {
      method: "POST",
      body: JSON.stringify({
        name: "Camiseta", description: "de algodón",
        price: 2500, currency: "PEN",
        imageUrls: ["https://ejemplo.test/camiseta.jpg"],
        retailerId: "SKU-1",
      }),
    });
    expect(res.status).toBe(201);
    const { data } = await j<{ data: { id: string; reviewStatus: string; price: number } }>(res);
    // Como en WhatsApp: hasta que lo aprueban no se ve. Decir que está
    // publicado sería prometer una visibilidad que no existe.
    expect(data.reviewStatus).toBe("PENDING");
    // El precio va en la unidad menor: 2500 son 25,00.
    expect(data.price).toBe(2500);
    producto = data.id;
  });

  it("rechaza un producto sin imágenes o con moneda inventada", async () => {
    const sinImagen = await llamar(`/v1/lines/${LINE}/products`, {
      method: "POST",
      body: JSON.stringify({
        name: "X", description: "y", price: 100, currency: "PEN", imageUrls: [],
      }),
    });
    expect(sinImagen.status).toBe(422);

    const monedaMala = await llamar(`/v1/lines/${LINE}/products`, {
      method: "POST",
      body: JSON.stringify({
        name: "X", description: "y", price: 100, currency: "SOLES",
        imageUrls: ["https://ejemplo.test/x.jpg"],
      }),
    });
    expect(monedaMala.status).toBe(422);
  });

  it("aparece en el catálogo y en una colección", async () => {
    const { data } = await j<{ data: { id: string }[] }>(
      await llamar(`/v1/lines/${LINE}/products`));
    expect(data.map((p) => p.id)).toContain(producto);

    const cols = await j<{ data: { products: { id: string }[] }[] }>(
      await llamar(`/v1/lines/${LINE}/collections`));
    expect(cols.data[0]!.products.map((p) => p.id)).toContain(producto);
  });

  it("editarlo lo devuelve a revisión", async () => {
    const res = await llamar(`/v1/lines/${LINE}/products/${enc(producto)}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "Camiseta azul", description: "de algodón",
        price: 2700, currency: "PEN",
        imageUrls: ["https://ejemplo.test/camiseta-azul.jpg"],
      }),
    });
    expect(res.status).toBe(200);
    const { data } = await j<{ data: { name: string; price: number; reviewStatus: string } }>(res);
    expect(data.name).toBe("Camiseta azul");
    expect(data.price).toBe(2700);
    expect(data.reviewStatus).toBe("PENDING");
  });

  it("borrar uno que no existe es 404, no un borrado de cero", async () => {
    expect((await llamar(`/v1/lines/${LINE}/products/no-existe`, { method: "DELETE" })).status)
      .toBe(404);
  });

  it("borrarlo lo quita del catálogo", async () => {
    expect((await llamar(`/v1/lines/${LINE}/products/${enc(producto)}`, { method: "DELETE" })).status)
      .toBe(200);
    const { data } = await j<{ data: { id: string }[] }>(
      await llamar(`/v1/lines/${LINE}/products`));
    expect(data.map((p) => p.id)).not.toContain(producto);
  });

  it("un pedido sin el testigo correcto no se lee", async () => {
    // El testigo viene dentro del mensaje del pedido y es de un solo uso: sin
    // él no hay forma de leerlo ni siendo su destinatario.
    const res = await llamar(`/v1/lines/${LINE}/orders/pedido-1?token=inventado`);
    expect(res.status).toBe(404);
  });
});
