import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres, { type Sql } from "postgres";
import { hasTestDatabase, TEST_DATABASE_URL, testSql, truncatePlatform } from "../testing.js";
import { ensurePlatformSchema } from "./ddl.js";
import { PostgresJobQueue } from "./queue.js";

const run = hasTestDatabase ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Conexión que cuenta las consultas de reclamo que manda, por cola. Es la
 * consulta que, con un `setInterval` de 20 ms por cola, lanzaba cien o
 * doscientas por segundo contra Postgres con Omni sin hacer nada.
 */
function countingSql(): { sql: Sql; claims: Map<string, number> } {
  const claims = new Map<string, number>();
  const sql = postgres(TEST_DATABASE_URL!, {
    max: 10,
    onnotice: () => {},
    debug: (_conn, query, params) => {
      if (!/UPDATE omni_job SET\s+claimed_until/.test(query)) return;
      const queue = (params as unknown[]).find((p) => typeof p === "string" && p.startsWith("qw_")) as string | undefined;
      if (queue) claims.set(queue, (claims.get(queue) ?? 0) + 1);
    },
  });
  return { sql, claims };
}

/** Espera a que se cumpla una condición, con tope; devuelve cuánto tardó. */
async function until(cond: () => boolean, timeoutMs = 5000): Promise<number> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("no se cumplió a tiempo");
    await sleep(2);
  }
  return Date.now() - t0;
}

run("cola de Postgres: sin sondeo continuo en reposo", () => {
  let admin: Sql;
  beforeAll(async () => {
    admin = testSql();
    await ensurePlatformSchema(admin);
    await truncatePlatform(admin);
  });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });

  it("en reposo, cada cola hace pocas consultas de reclamo (≤ 10 en 3 s)", async () => {
    const { sql, claims } = countingSql();
    const cola = new PostgresJobQueue(sql);
    const subs = ["qw_reposo_a", "qw_reposo_b", "qw_reposo_c"].map((q) =>
      cola.process(q, async () => {}, { concurrency: 4 }));
    await sleep(3000);
    const enTres = new Map(claims);
    // Ya en régimen: como mucho una por segundo y cola, más algo de holgura.
    claims.clear();
    await sleep(2000);
    for (const s of subs) await s.stop();
    await cola.close();
    await sql.end({ timeout: 5 });

    for (const q of ["qw_reposo_a", "qw_reposo_b", "qw_reposo_c"]) {
      // Con el intervalo fijo de 20 ms serían ~150 por cola.
      expect(enTres.get(q) ?? 0, `${q} en los 3 primeros segundos`).toBeLessThanOrEqual(10);
      expect(enTres.get(q) ?? 0, `${q} no llegó a reclamar`).toBeGreaterThan(0);
      expect(claims.get(q) ?? 0, `${q} en régimen (2 s)`).toBeLessThanOrEqual(3);
    }
  });

  it("un trabajo encolado en el mismo proceso se atiende al momento aunque la cola esté en espera larga", async () => {
    const sql = testSql();
    const cola = new PostgresJobQueue(sql, { notifications: false });
    let llegada = 0;
    const sub = cola.process("qw_local", async () => { llegada = Date.now(); });
    // Deja que la espera crezca hasta el tope.
    await sleep(2000);
    await cola.enqueue("qw_local", { v: 1 });
    const t0 = Date.now();
    await until(() => llegada > 0);
    const latencia = llegada - t0;
    await sub.stop();
    await cola.close();
    await sql.end({ timeout: 5 });
    expect(latencia).toBeLessThan(50);
  });

  it("un trabajo encolado desde otro proceso se atiende al momento gracias a NOTIFY", async () => {
    // Dos instancias con conexiones distintas: lo mismo que la API y el worker.
    const sqlConsumidor = testSql();
    const sqlProductor = testSql();
    const consumidor = new PostgresJobQueue(sqlConsumidor);
    const productor = new PostgresJobQueue(sqlProductor);
    const latencias: number[] = [];
    let t0 = 0;
    const sub = consumidor.process("qw_remoto", async () => { latencias.push(Date.now() - t0); });
    await sleep(2000);
    for (let i = 0; i < 3; i++) {
      await productor.enqueue("qw_remoto", { i });
      t0 = Date.now();
      await until(() => latencias.length === i + 1);
      await sleep(1500); // vuelve a la espera larga entre uno y otro
    }
    await sub.stop();
    await consumidor.close();
    await productor.close();
    await sqlConsumidor.end({ timeout: 5 });
    await sqlProductor.end({ timeout: 5 });
    // Sin aviso, cada uno esperaría hasta el tope de 1 s.
    for (const l of latencias) expect(l).toBeLessThan(150);
  });

  it("sin NOTIFY, un trabajo de otro proceso se recoge igualmente en ≤ 1,5 s", async () => {
    const sqlConsumidor = testSql();
    const sqlProductor = testSql();
    const consumidor = new PostgresJobQueue(sqlConsumidor, { notifications: false });
    const productor = new PostgresJobQueue(sqlProductor, { notifications: false });
    let llegada = 0;
    const sub = consumidor.process("qw_sin_aviso", async () => { llegada = Date.now(); });
    await sleep(2000);
    await productor.enqueue("qw_sin_aviso", {});
    const t0 = Date.now();
    await until(() => llegada > 0, 5000);
    const latencia = llegada - t0;
    await sub.stop();
    await consumidor.close();
    await productor.close();
    await sqlConsumidor.end({ timeout: 5 });
    await sqlProductor.end({ timeout: 5 });
    expect(latencia).toBeLessThanOrEqual(1500);
  });

  it("los reintentos respetan el backoff y se recogen a su hora, no al tope de la espera", async () => {
    const sql = testSql();
    const cola = new PostgresJobQueue(sql, { notifications: false });
    const intentos: number[] = [];
    const sub = cola.process("qw_reintento", async () => {
      intentos.push(Date.now());
      if (intentos.length < 3) throw new Error("todavía no");
    });
    await cola.enqueue("qw_reintento", {}, { maxAttempts: 5, backoffMs: 300 });
    await until(() => intentos.length >= 3, 8000);
    await sleep(300);
    await sub.stop();
    await cola.close();
    const rows = await sql<{ done: boolean; attempt: number }[]>`
      SELECT done, attempt FROM omni_job WHERE queue = 'qw_reintento'`;
    await sql.end({ timeout: 5 });

    expect(intentos).toHaveLength(3);
    expect(rows).toEqual([{ done: true, attempt: 3 }]);
    // backoffDelay: base·2^(intento-1) con ±20 % de jitter → ~300 ms y ~600 ms.
    const huecos = [intentos[1]! - intentos[0]!, intentos[2]! - intentos[1]!];
    expect(huecos[0]).toBeGreaterThanOrEqual(300 * 0.8 - 20);
    expect(huecos[0]).toBeLessThan(300 * 1.2 + 150);
    expect(huecos[1]).toBeGreaterThanOrEqual(600 * 0.8 - 20);
    expect(huecos[1]).toBeLessThan(600 * 1.2 + 150);
  });

  it("stop() y close() no dejan temporizadores ni rechazos sueltos", async () => {
    const sql = testSql();
    const cola = new PostgresJobQueue(sql);
    const sueltos: unknown[] = [];
    const anotar = (e: unknown): void => { sueltos.push(e); };
    process.on("unhandledRejection", anotar);
    try {
      const hechos: number[] = [];
      const sub = cola.process<{ n: number }>("qw_cierre", async (p) => {
        await sleep(50);
        hechos.push(p.n);
      });
      for (let n = 0; n < 3; n++) await cola.enqueue("qw_cierre", { n });
      await until(() => hechos.length > 0);
      await sub.stop();
      // Tras stop no se reclama nada más: lo que quede, queda en la cola.
      const tras = hechos.length;
      await cola.enqueue("qw_cierre", { n: 99 });
      await sleep(200);
      expect(hechos.length).toBe(tras);
      expect(hechos).not.toContain(99);
      await cola.close();
      await sql.end({ timeout: 5 });
      await sleep(100);
      expect(sueltos).toEqual([]);
    } finally {
      process.off("unhandledRejection", anotar);
    }
  });
});
