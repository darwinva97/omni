import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { hasTestDatabase, testSql } from "../testing.js";
import { ensurePlatformSchema } from "./ddl.js";
import { PostgresJobQueue } from "./queue.js";
import { PostgresKv } from "./kv.js";

const run = hasTestDatabase ? describe : describe.skip;

/**
 * La API comparte UNA conexión entre Drizzle, la cola y el KV. Las pruebas de
 * contrato usaban una conexión limpia, y por eso no vieron un fallo que
 * reventaba todos los envíos en producción: había que reproducir la condición
 * real, no una parecida.
 */
run("conexión compartida con Drizzle", () => {
  it("la cola y el KV funcionan después de que Drizzle use la misma conexión", async () => {
    const sql = testSql();
    const db = drizzle(sql);
    await ensurePlatformSchema(sql);

    // Drizzle primero, como en el arranque real de la API.
    await db.execute("SELECT 1");

    const kv = new PostgresKv(sql);
    const queue = new PostgresJobQueue(sql);

    const errores: string[] = [];
    try {
      await kv.setIfAbsent(`compartida:${Date.now()}`, "valor", 604800);
    } catch (e) { errores.push(`kv.setIfAbsent → ${(e as Error).message}`); }

    try {
      await queue.enqueue("compartida", {
        lineId: "l1", orgId: "o1", clientMessageId: "c1",
        input: { to: "51999000111", text: "hola" }, kind: "text",
        sentByUserId: null, sentByConnectorId: null,
      }, { partitionKey: "line:l1", idempotencyKey: `send:l1:${Date.now()}`, maxAttempts: 3, backoffMs: 2000 });
    } catch (e) { errores.push(`queue.enqueue → ${(e as Error).message}`); }

    expect(errores.join(" | ")).toBe("");
    await queue.close();
    await sql.end({ timeout: 5 });
  });

  it("la carga vuelve como objeto, no como cadena", async () => {
    // Doble codificación: el manejador recibiría '{"v":1}' en vez de {v:1}.
    const sql = testSql();
    drizzle(sql);
    await ensurePlatformSchema(sql);
    const queue = new PostgresJobQueue(sql);

    const recibidas: unknown[] = [];
    const sub = queue.process("compartida-payload", async (p) => void recibidas.push(p));
    await queue.enqueue("compartida-payload", { v: 1, anidado: { a: "b" } });
    const deadline = Date.now() + 4000;
    while (recibidas.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await sub.stop();
    await queue.close();
    await sql.end({ timeout: 5 });

    expect(recibidas[0]).toEqual({ v: 1, anidado: { a: "b" } });
  });
});
