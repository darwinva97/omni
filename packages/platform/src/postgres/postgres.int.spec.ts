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
