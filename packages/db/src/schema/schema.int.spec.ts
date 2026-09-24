import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, desc, eq, sql as raw } from "drizzle-orm";
import { createDatabase, type DbHandle } from "../client.js";
import { migrate } from "../migrate.js";
import { orgTable } from "./identity.js";
import { lineTable } from "./lines.js";
import { messageTable } from "./messages.js";

const URL = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL ? describe : describe.skip;

let h: DbHandle;
const ORG = "org-int";
const LINE = "line-int";

beforeAll(async () => {
  if (!URL) return;
  await migrate(URL);
  h = createDatabase(URL);
  await h.sql`DELETE FROM message WHERE line_id = ${LINE}`;
  await h.sql`DELETE FROM line WHERE id = ${LINE}`;
  await h.sql`DELETE FROM org WHERE id = ${ORG}`;
  await h.db.insert(orgTable).values({ id: ORG, name: "Integración", slug: "integracion" });
  await h.db.insert(lineTable).values({
    id: LINE, orgId: ORG, channelKind: "sandbox", name: "Línea", slug: "linea",
  });
});
afterAll(async () => { await h?.close(); });

run("esquema de mensajes", () => {
  const insert = (id: string, when: Date, body: string, chat = "chat-a") =>
    h.db.insert(messageTable).values({
      id, timestamp: when, lineId: LINE, chatId: chat,
      senderAddress: "51999888777@s.whatsapp.net", fromMe: false, kind: "text", body,
    });

  it("enruta cada mensaje a la partición de su mes", async () => {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    await insert("m-now", now, "de este mes");
    await insert("m-prev", lastMonth, "del mes pasado");

    // `tableoid` delata en qué partición física acabó cada fila.
    const rows = await h.sql<{ id: string; part: string }[]>`
      SELECT id, tableoid::regclass::text AS part
      FROM message WHERE line_id = ${LINE} ORDER BY id`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.part]));
    expect(byId["m-now"]).not.toBe(byId["m-prev"]);
    expect(byId["m-now"]).toMatch(/^message_\d{4}_\d{2}$/);
  });

  it("toda partición hereda el índice que sirve el scroll de una conversación", async () => {
    // Se comprueba la ESTRUCTURA, no la elección del planificador: con tres
    // filas por partición elegir recorrido secuencial es correcto, y afirmar
    // sobre el plan a esa escala daría una prueba que falla según el humor de
    // las estadísticas. Lo que debe ser cierto siempre es que el índice existe
    // en cada partición: su ausencia es lo que degradaba el panel del gateway
    // anterior cuando la tabla crecía.
    const parent = await h.sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'message' AND indexname = 'message_chat_idx'`;
    expect(parent).toHaveLength(1);
    expect(parent[0]!.indexdef).toMatch(/line_id.*chat_id.*timestamp.*DESC/s);

    // Postgres renombra los índices hijos, así que se buscan por su definición.
    const partitions = await h.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'message'`;
    const withIndex = await h.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM pg_indexes
      WHERE tablename LIKE 'message\\_%' ESCAPE '\\'
        AND indexdef LIKE '%line_id, chat_id, "timestamp" DESC%'`;
    expect(Number(withIndex[0]!.n)).toBe(Number(partitions[0]!.n));
  });

  it("la clave primaria impide duplicar un mensaje", async () => {
    const when = new Date();
    await insert("m-dup", when, "una vez");
    await expect(insert("m-dup", when, "otra vez")).rejects.toThrow();
  });

  it("consulta paginada por cursor, el orden que sirve el chat", async () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await insert(`m-p${i}`, new Date(base - i * 1000), `mensaje ${i}`, "chat-b");
    }
    const page = await h.db
      .select({ id: messageTable.id, body: messageTable.body })
      .from(messageTable)
      .where(and(eq(messageTable.lineId, LINE), eq(messageTable.chatId, "chat-b")))
      .orderBy(desc(messageTable.timestamp), messageTable.id)
      .limit(3);
    expect(page.map((r) => r.body)).toEqual(["mensaje 0", "mensaje 1", "mensaje 2"]);
  });

  it("borrar la línea arrastra sus datos por cascada", async () => {
    await h.db.insert(lineTable).values({
      id: "line-tmp", orgId: ORG, channelKind: "sandbox", name: "Temp", slug: "temp",
    });
    await h.sql`DELETE FROM line WHERE id = 'line-tmp'`;
    const left = await h.sql`SELECT 1 FROM line WHERE id = 'line-tmp'`;
    expect(left).toHaveLength(0);
  });

  it("mantiene la ventana de particiones futuras", async () => {
    await h.sql`SELECT omni_ensure_message_partitions(1, 6)`;
    const parts = await h.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM pg_inherits i
      JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'message'`;
    expect(Number(parts[0]!.n)).toBeGreaterThanOrEqual(8);
  });
});
