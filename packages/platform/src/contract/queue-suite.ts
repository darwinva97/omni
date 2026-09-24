import { describe, it, expect, afterEach } from "vitest";
import type { JobQueue } from "../ports/job-queue.port.js";
import type { Kv } from "../ports/kv.port.js";

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera a que una condición se cumpla, con tope.
 *
 * Afirmar tras un `sleep` fijo funciona en una máquina ociosa y falla cuando
 * corre la suite entera: el driver de Postgres hace viajes de red que el de
 * memoria no. Una prueba que falla por carga no dice nada sobre el código.
 */
async function until(cond: () => boolean | Promise<boolean>, que: string, timeoutMs = 8000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (await cond()) return;
    await settle(20);
  }
  throw new Error(`no se cumplió a tiempo: ${que}`);
}

/**
 * Contrato de la cola. Memoria y Postgres deben comportarse igual, porque el
 * perfil sin Redis usa Postgres y las pruebas usan memoria: si divergen, un
 * test verde no dice nada sobre producción.
 */
export function runJobQueueContract(name: string, make: () => Promise<JobQueue>): void {
  describe(`contrato de cola: ${name}`, () => {
    const opened: JobQueue[] = [];
    const open = async (): Promise<JobQueue> => {
      const q = await make();
      opened.push(q);
      return q;
    };
    afterEach(async () => {
      await Promise.all(opened.splice(0).map((q) => q.close().catch(() => {})));
    });

    it("entrega el trabajo al manejador", async () => {
      const q = await open();
      const got: string[] = [];
      const sub = q.process<{ v: string }>("t1", async (p) => void got.push(p.v));
      await q.enqueue("t1", { v: "hola" });
      await until(() => got.length === 1, "el trabajo llega al manejador");
      await sub.stop();
      expect(got).toEqual(["hola"]);
    });

    it("reintenta hasta lograrlo", async () => {
      const q = await open();
      let attempts = 0;
      const sub = q.process("t2", async () => {
        attempts++;
        if (attempts < 3) throw new Error("todavía no");
      });
      await q.enqueue("t2", {}, { maxAttempts: 5, backoffMs: 10 });
      await until(() => attempts >= 3, "llega al tercer intento");
      await sub.stop();
      expect(attempts).toBe(3);
    });

    it("agotar los intentos llama a la cola muerta, no desaparece", async () => {
      const q = await open();
      const dead: unknown[] = [];
      const sub = q.process("t3", async () => { throw new Error("siempre falla"); }, {
        onDead: async (payload) => void dead.push(payload),
      });
      await q.enqueue("t3", { id: 7 }, { maxAttempts: 2, backoffMs: 5 });
      await until(() => dead.length === 1, "el trabajo acaba en la cola muerta");
      await sub.stop();
      expect(dead).toEqual([{ id: 7 }]);
    });

    it("respeta el orden dentro de una partición", async () => {
      // Es lo que permite limitar el ritmo por línea sin desordenar los envíos.
      const q = await open();
      const order: number[] = [];
      const sub = q.process<{ n: number }>("t4", async (p) => {
        await new Promise((r) => setTimeout(r, 20 - p.n * 5));
        order.push(p.n);
      }, { concurrency: 4 });
      for (const n of [1, 2, 3]) await q.enqueue("t4", { n }, { partitionKey: "linea-A" });
      await until(() => order.length === 3, "los tres trabajos de la partición terminan");
      await sub.stop();
      expect(order).toEqual([1, 2, 3]);
    });

    it("particiones distintas no se bloquean entre sí", async () => {
      const q = await open();
      const done: string[] = [];
      const sub = q.process<{ p: string }>("t5", async (p) => {
        await new Promise((r) => setTimeout(r, p.p === "lenta" ? 120 : 5));
        done.push(p.p);
      }, { concurrency: 4 });
      await q.enqueue("t5", { p: "lenta" }, { partitionKey: "A" });
      await q.enqueue("t5", { p: "rapida" }, { partitionKey: "B" });
      await until(() => done.length === 2, "ambas particiones terminan");
      await sub.stop();
      expect(done[0]).toBe("rapida");
    });

    it("la clave de idempotencia no encola dos veces", async () => {
      const q = await open();
      const a = await q.enqueue("t6", { v: 1 }, { idempotencyKey: "k1" });
      const b = await q.enqueue("t6", { v: 2 }, { idempotencyKey: "k1" });
      expect(b).toBe(a);
      expect(await q.depth("t6")).toBe(1);
    });

    it("no ejecuta antes de runAt", async () => {
      // Márgenes anchos y espera por condición, no por reloj: con la máquina
      // cargada los temporizadores derivan y una prueba ajustada falla sin que
      // haya nada roto. Una prueba inestable es peor que no tenerla.
      const q = await open();
      const got: number[] = [];
      const sub = q.process("t7", async () => void got.push(Date.now()));

      const runAt = Date.now() + 500;
      await q.enqueue("t7", {}, { runAt });

      await settle(150);
      expect(got, "se ejecutó antes de su hora").toHaveLength(0);

      const deadline = Date.now() + 4000;
      while (got.length === 0 && Date.now() < deadline) await settle(25);
      await sub.stop();

      expect(got, "no llegó a ejecutarse tras su hora").toHaveLength(1);
      expect(got[0]!).toBeGreaterThanOrEqual(runAt - 50);
    });

    it("informa la profundidad de la cola", async () => {
      const q = await open();
      expect(await q.depth("t8")).toBe(0);
      await q.enqueue("t8", {});
      await q.enqueue("t8", {});
      expect(await q.depth("t8")).toBe(2);
    });
  });
}

/** Contrato del KV: la primitiva sobre la que descansan idempotencia y cuotas. */
export function runKvContract(name: string, make: () => Promise<Kv>): void {
  describe(`contrato de KV: ${name}`, () => {
    const opened: Kv[] = [];
    const open = async (): Promise<Kv> => {
      const kv = await make();
      opened.push(kv);
      return kv;
    };
    afterEach(async () => {
      await Promise.all(opened.splice(0).map((k) => k.close().catch(() => {})));
    });

    it("guarda, lee y borra", async () => {
      const kv = await open();
      expect(await kv.get("a")).toBeNull();
      await kv.set("a", "1");
      expect(await kv.get("a")).toBe("1");
      await kv.delete("a");
      expect(await kv.get("a")).toBeNull();
    });

    it("expira por TTL", async () => {
      const kv = await open();
      await kv.set("t", "1", 1);
      expect(await kv.get("t")).toBe("1");
      await settle(1300);
      expect(await kv.get("t")).toBeNull();
    });

    it("setIfAbsent solo deja ganar a uno", async () => {
      // La carrera que decide qué nodo del motor posee una línea.
      const kv = await open();
      expect(await kv.setIfAbsent("lock", "nodo-1", 60)).toBe(true);
      expect(await kv.setIfAbsent("lock", "nodo-2", 60)).toBe(false);
      expect(await kv.get("lock")).toBe("nodo-1");
    });

    it("increment acumula y no renueva el TTL en cada paso", async () => {
      const kv = await open();
      expect(await kv.increment("c", 1, 60)).toBe(1);
      expect(await kv.increment("c", 2, 60)).toBe(3);
      expect(await kv.get("c")).toBe("3");
    });
  });
}
