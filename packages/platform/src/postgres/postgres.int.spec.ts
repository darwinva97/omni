import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Sql } from "postgres";
import { runJobQueueContract, runKvContract } from "../contract/queue-suite.js";
import { hasTestDatabase, testSql, truncatePlatform } from "../testing.js";
import { ensurePlatformSchema } from "./ddl.js";
import { PostgresJobQueue } from "./queue.js";
import { PostgresKv } from "./kv.js";
import { PostgresBus } from "./bus.js";

const run = hasTestDatabase ? describe : describe.skip;
let sql: Sql;

beforeAll(async () => {
  if (!hasTestDatabase) return;
  sql = testSql();
  await ensurePlatformSchema(sql);
  await truncatePlatform(sql);
});
afterAll(async () => { await sql?.end({ timeout: 5 }); });

// Exactamente la misma batería que corre contra memoria. Si divergen, se ve aquí.
if (hasTestDatabase) {
  runJobQueueContract("postgres", async () => {
    await truncatePlatform(sql);
    return new PostgresJobQueue(sql);
  });
  runKvContract("postgres", async () => {
    await truncatePlatform(sql);
    return new PostgresKv(sql);
  });
}

run("bus de Postgres (LISTEN/NOTIFY)", () => {
  it("entrega a los suscriptores del tema", async () => {
    const own = testSql();
    const bus = new PostgresBus(own);
    const got: unknown[] = [];
    const off = await bus.subscribe("t_demo", (p) => void got.push(p));
    await new Promise((r) => setTimeout(r, 150));
    await bus.publish("t_demo", { hola: "mundo" });
    await new Promise((r) => setTimeout(r, 500));
    await off();
    await bus.close();
    await own.end({ timeout: 5 });
    expect(got).toEqual([{ hola: "mundo" }]);
  });

  it("rechaza una carga mayor que el límite de NOTIFY con un mensaje útil", async () => {
    const own = testSql();
    const bus = new PostgresBus(own);
    await expect(bus.publish("t_big", { x: "a".repeat(9000) })).rejects.toThrow(/NOTIFY/);
    await bus.close();
    await own.end({ timeout: 5 });
  });
});

run("cola de Postgres con la base cerrándose", () => {
  it("un trabajo que falla mientras se cierra la conexión no deja un rechazo suelto", async () => {
    /*
     * Lo que tumbaba CI de vez en cuando —y en producción tumbaría el
     * proceso—: el trabajo falla, `#run` intenta apuntar el fallo y la
     * conexión ya se está cerrando. Ese UPDATE rechazaba sin que nadie lo
     * esperara.
     */
    const own = testSql();
    const cola = new PostgresJobQueue(own);
    const sueltos: unknown[] = [];
    const anotar = (e: unknown): void => { sueltos.push(e); };
    process.on("unhandledRejection", anotar);
    try {
      let empezo!: () => void;
      const enMarcha = new Promise<void>((r) => { empezo = r; });
      await cola.enqueue("q_cierre", { n: 1 });
      cola.process("q_cierre", async () => {
        empezo();
        // Falla DESPUÉS de que la conexión empiece a cerrarse.
        await new Promise((r) => setTimeout(r, 100));
        throw new Error("falla a propósito");
      });
      await enMarcha;
      await own.end({ timeout: 1 });
      await new Promise((r) => setTimeout(r, 400));
      expect(sueltos).toEqual([]);
    } finally {
      process.off("unhandledRejection", anotar);
    }
  });
});
