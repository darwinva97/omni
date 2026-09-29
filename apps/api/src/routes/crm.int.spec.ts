import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiKeyTable, createDatabase, lineTable, migrate, orgTable, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";
import { mintApiKey } from "../keys.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-crm";
const LINE = "line-crm";
const CONTACTO = "51977666555";
const CHAT = `${CONTACTO}@s.whatsapp.net`;

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let clave = "";
const webhooksRecibidos: string[] = [];

const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;

const llamar = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${clave}`, "content-type": "application/json", ...init.headers },
  });

const esperar = async (cond: () => Promise<boolean>, que: string, ms = 8000): Promise<void> => {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 70));
  }
  throw new Error(`no se cumplió: ${que}`);
};

const entrante = (texto: string, de = CONTACTO) =>
  llamar(`/v1/sandbox/lines/${LINE}/inbound`, {
    method: "POST", body: JSON.stringify({ from: de, text: texto }),
  });

const salientes = async (): Promise<string[]> => {
  const filas = await dbh.sql`
    SELECT body FROM message WHERE line_id = ${LINE} AND from_me = true ORDER BY timestamp`;
  return filas.map((f) => String(f["body"] ?? ""));
};

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  await dbh.sql`DELETE FROM automation_run WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM automation_rule WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM conversation WHERE org_id = ${ORG}`;
  for (const t of ["message", "chat", "auth_state", "label_assignment"]) {
    await dbh.sql.unsafe(`DELETE FROM ${t} WHERE line_id = '${LINE}'`).catch(() => {});
  }
  await dbh.sql`DELETE FROM api_key WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM line WHERE org_id = ${ORG}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.db.insert(orgTable).values({ id: ORG, name: "CRM", slug: "crm" });
  await dbh.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "L", slug: "l-crm",
    address: "51999888777@s.whatsapp.net", sendRatePerMinute: 6000,
  });
  const k = await mintApiKey();
  clave = k.plaintext;
  await dbh.db.insert(apiKeyTable).values({
    id: "k-crm", orgId: ORG, name: "admin", prefix: k.prefix, secretHash: k.secretHash, role: "admin",
  });

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "7".repeat(64),
      SANDBOX_ENABLED: "true", MEDIA_DIR: "./.data/test-media-crm",
    } as NodeJS.ProcessEnv),
    {
      runMigrations: false,
      fetchImpl: (async (url: string) => {
        webhooksRecibidos.push(String(url));
        return String(url).includes("roto") ? new Response("no", { status: 500 }) : new Response("ok");
      }) as unknown as typeof fetch,
    },
  );
  app = createApp(container);
  await llamar(`/v1/lines/${LINE}/connect`, { method: "POST" });
  await llamar(`/v1/sandbox/lines/${LINE}/scan`, {
    method: "POST", body: JSON.stringify({ phone: "51999888777" }),
  });
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

async function crearRegla(regla: Record<string, unknown>, encender = true): Promise<string> {
  const res = await llamar("/v1/automations", { method: "POST", body: JSON.stringify(regla) });
  expect(res.status).toBe(201);
  const { data } = await j<{ data: { id: string; enabled: boolean } }>(res);
  expect(data.enabled, "una regla recién creada NO puede estar encendida").toBe(false);
  if (encender) {
    await llamar(`/v1/automations/${data.id}`, {
      method: "PATCH", body: JSON.stringify({ enabled: true }),
    });
  }
  return data.id;
}

run("conversaciones", () => {
  it("el primer mensaje abre una conversación, y el segundo no abre otra", async () => {
    await entrante("hola");
    await esperar(async () => {
      const { data } = await j<{ data: unknown[] }>(await llamar("/v1/conversations"));
      return data.length === 1;
    }, "se abrió la conversación");

    await entrante("sigo aquí");
    await new Promise((r) => setTimeout(r, 500));
    const { data } = await j<{ data: { chatId: string }[] }>(await llamar("/v1/conversations"));
    // Dos abiertas repartirían los mensajes de una misma persona entre dos
    // expedientes, y ninguna métrica volvería a significar nada.
    expect(data.filter((c) => c.chatId === CHAT)).toHaveLength(1);
  });

  it("resolverla deja fecha, y reabrirla la quita", async () => {
    const { data } = await j<{ data: { id: string }[] }>(await llamar("/v1/conversations"));
    const id = data[0]!.id;

    const resuelta = await j<{ data: { status: string; resolvedAt: string | null } }>(
      await llamar(`/v1/conversations/${id}`, {
        method: "PATCH", body: JSON.stringify({ status: "resolved" }),
      }));
    expect(resuelta.data.resolvedAt).not.toBeNull();

    const reabierta = await j<{ data: { resolvedAt: string | null } }>(
      await llamar(`/v1/conversations/${id}`, {
        method: "PATCH", body: JSON.stringify({ status: "open" }),
      }));
    // Una fecha de resolución en una conversación abierta es una mentira.
    expect(reabierta.data.resolvedAt).toBeNull();
  });

  it("un mensaje entrante reabre lo que estaba en espera", async () => {
    const { data } = await j<{ data: { id: string }[] }>(await llamar("/v1/conversations"));
    const id = data[0]!.id;
    await llamar(`/v1/conversations/${id}`, {
      method: "PATCH", body: JSON.stringify({ status: "pending" }),
    });

    await entrante("¿hay alguien?");
    await esperar(async () => {
      const { data: d } = await j<{ data: { id: string; status: string }[] }>(
        await llamar("/v1/conversations"));
      return d.find((c) => c.id === id)?.status === "open";
    }, "la conversación volvió a la bandeja");
  });
});

run("automatizaciones", () => {
  it("una regla con condición responde sola, y solo a lo que cumple", async () => {
    await crearRegla({
      name: "Facturación",
      trigger: "message.received",
      conditions: [{ field: "text", op: "contains", value: "factura" }],
      actions: [{ type: "send_message", text: "te paso con administración", asReply: true }],
      priority: 10,
    });

    await entrante("necesito una FACTURA");
    await esperar(
      async () => (await salientes()).some((b) => b.includes("administración")),
      "la regla respondió",
    );

    const antes = await salientes();
    await entrante("gracias, nada más");
    await new Promise((r) => setTimeout(r, 900));
    const despues = await salientes();
    expect(despues, `respondió a algo que no cumplía: ${JSON.stringify(despues.slice(antes.length))}`)
      .toHaveLength(antes.length);
  });

  it("no se responde a su propia respuesta", async () => {
    // Una regla sobre `message.sent` que envía es el bucle en su forma más
    // directa: sin el corte por profundidad crecería sin fin.
    await crearRegla({
      name: "Eco de lo enviado",
      trigger: "message.sent",
      conditions: [{ field: "text", op: "contains", value: "ping" }],
      actions: [{ type: "send_message", text: "ping" }],
      priority: 20,
    });

    await llamar(`/v1/lines/${LINE}/messages`, {
      method: "POST", body: JSON.stringify({ to: CHAT, text: "ping", clientMessageId: "manual-ping" }),
    });

    await new Promise((r) => setTimeout(r, 2500));
    const pings = (await salientes()).filter((b) => b === "ping");
    // El manual y como mucho una vuelta de la regla. Sin el corte serían
    // decenas y subiendo.
    expect(pings.length).toBeLessThanOrEqual(2);
  });

  it("un webhook que responde mal queda registrado como fallo, no como éxito", async () => {
    const id = await crearRegla({
      name: "Aviso roto",
      trigger: "message.received",
      conditions: [{ field: "text", op: "contains", value: "urgente" }],
      actions: [{ type: "webhook", url: "https://roto.test/aviso" }],
      priority: 30,
    });

    await entrante("esto es urgente");
    await esperar(async () => {
      const { data } = await j<{ data: { outcome: string; reason: string | null }[] }>(
        await llamar(`/v1/automations/${id}/runs?outcome=failed`));
      return data.length > 0 && (data[0]!.reason ?? "").includes("500");
    }, "el fallo del webhook se ve en el historial");
  });

  it("`stop` corta la cadena para las reglas de menor prioridad", async () => {
    await crearRegla({
      name: "Corta",
      trigger: "message.received",
      conditions: [{ field: "text", op: "contains", value: "cortar" }],
      actions: [{ type: "set_priority", priority: "urgent" }, { type: "stop" }],
      priority: 1,
    });
    const abajo = await crearRegla({
      name: "No debería correr",
      trigger: "message.received",
      conditions: [{ field: "text", op: "contains", value: "cortar" }],
      actions: [{ type: "send_message", text: "no debería salir" }],
      priority: 999,
    });

    await entrante("hay que cortar");
    await esperar(async () => {
      const { data } = await j<{ data: { priority: string }[] }>(await llamar("/v1/conversations"));
      return data.some((c) => c.priority === "urgent");
    }, "la primera regla actuó");

    await new Promise((r) => setTimeout(r, 600));
    expect((await salientes()).some((b) => b === "no debería salir")).toBe(false);
    const { data } = await j<{ data: unknown[] }>(await llamar(`/v1/automations/${abajo}/runs`));
    expect(data, "la regla cortada no debería haber llegado a ejecutarse").toHaveLength(0);
  });

  it("encender una regla no le borra las condiciones", async () => {
    /*
     * `RuleInput.partial()` hacía las claves opcionales pero mantenía sus
     * valores por defecto, así que un PATCH de `{enabled:true}` llegaba con
     * `conditions: []` y las borraba: la regla pasaba a dispararse con
     * cualquier mensaje. Un PATCH que destruye lo que no menciona es el peor
     * fallo que puede tener una ruta de edición.
     */
    const res = await llamar("/v1/automations", {
      method: "POST",
      body: JSON.stringify({
        name: "Con condiciones",
        trigger: "message.received",
        conditions: [{ field: "text", op: "contains", value: "algo-muy-concreto" }],
        actions: [{ type: "add_label", labelId: "x" }],
        priority: 42,
      }),
    });
    const { data } = await j<{ data: { id: string } }>(res);

    await llamar(`/v1/automations/${data.id}`, {
      method: "PATCH", body: JSON.stringify({ enabled: true }),
    });

    const { data: reglas } = await j<{ data: { id: string; conditions: unknown[]; priority: number }[] }>(
      await llamar("/v1/automations"));
    const regla = reglas.find((r) => r.id === data.id)!;
    expect(regla.conditions).toHaveLength(1);
    expect(regla.priority).toBe(42);
  });

  it("una regla apagada no hace nada", async () => {
    const id = await crearRegla({
      name: "Dormida",
      trigger: "message.received",
      actions: [{ type: "send_message", text: "no salgo" }],
    }, false);

    await entrante("cualquier cosa");
    await new Promise((r) => setTimeout(r, 700));
    expect((await salientes()).some((b) => b === "no salgo")).toBe(false);
    const { data } = await j<{ data: unknown[] }>(await llamar(`/v1/automations/${id}/runs`));
    expect(data).toHaveLength(0);
  });
});
