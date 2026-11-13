import { describe, it, expect } from "vitest";
import { ColaEnSerie, fundirPorClave, procesarPorLotes } from "./por-lotes.js";

describe("procesar por lotes", () => {
  it("pasa cada elemento una sola vez, sin más de `paralelo` en vuelo", async () => {
    const vistos: number[] = [];
    let enVuelo = 0;
    let maxEnVuelo = 0;
    await procesarPorLotes(Array.from({ length: 1000 }, (_, i) => i), async (i) => {
      enVuelo++;
      maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
      await new Promise((r) => setTimeout(r, 0));
      vistos.push(i);
      enVuelo--;
    }, { lote: 50, paralelo: 3 });

    expect(vistos).toHaveLength(1000);
    expect(new Set(vistos).size).toBe(1000);
    expect(maxEnVuelo).toBe(3);
  });

  it("cede el turno entre lotes aunque el trabajo no espere a nada", async () => {
    /*
     * El peor caso: cada elemento resuelve en microtareas y, sin ceder a
     * propósito, el lote entero —y el siguiente, y el otro— correría sin que
     * el event loop atendiera nada más. Un `setImmediate` que se reprograma
     * cuenta cuántos elementos pasan entre turno y turno.
     */
    let desdeElTurno = 0;
    let maxEntreTurnos = 0;
    let midiendo = true;
    const turno = (): void => {
      maxEntreTurnos = Math.max(maxEntreTurnos, desdeElTurno);
      desdeElTurno = 0;
      if (midiendo) setImmediate(turno);
    };
    setImmediate(turno);

    await procesarPorLotes(Array.from({ length: 5000 }, (_, i) => i), async () => {
      desdeElTurno++;
    }, { lote: 100 });
    midiendo = false;

    expect(maxEntreTurnos).toBeGreaterThan(0);
    expect(maxEntreTurnos).toBeLessThanOrEqual(100);
  });

  it("un elemento que falla no corta el resto", async () => {
    const vistos: number[] = [];
    await procesarPorLotes([1, 2, 3, 4, 5], async (i) => {
      if (i === 2) throw new Error("roto");
      vistos.push(i);
    }, { lote: 2, paralelo: 1 });
    expect(vistos).toEqual([1, 3, 4, 5]);
  });
});

describe("fundir por clave", () => {
  it("lo repetido sale una vez, y un campo ausente no borra el que había", () => {
    const fundidos = fundirPorClave([
      { id: "a", name: "Ana", notify: undefined as string | undefined },
      { id: "b", name: "Beto" },
      { id: "a", name: undefined, notify: "Anita" },
      { id: undefined, name: "sin clave" },
    ], (c) => c.id);
    expect(fundidos).toEqual([
      { id: "a", name: "Ana", notify: "Anita" },
      { id: "b", name: "Beto" },
      { id: undefined, name: "sin clave" },
    ]);
  });

  it("un `null` sí cuenta: es «se quitó», no «no vino»", () => {
    const [chat] = fundirPorClave([
      { id: "c", muteEndTime: 123 as number | null },
      { id: "c", muteEndTime: null },
    ], (c) => c.id);
    expect(chat).toEqual({ id: "c", muteEndTime: null });
  });

  it("no toca los objetos que recibe", () => {
    const original = { id: "a", name: "Ana" };
    fundirPorClave([original, { id: "a", name: "Otra" }], (c) => c.id);
    expect(original.name).toBe("Ana");
  });
});

describe("cola en serie", () => {
  it("cada tarea empieza al acabar la anterior, aunque una falle", async () => {
    const cola = new ColaEnSerie();
    const orden: string[] = [];
    void cola.encolar(async () => {
      await new Promise((r) => setTimeout(r, 20));
      orden.push("primera");
    });
    void cola.encolar(async () => {
      orden.push("rota");
      throw new Error("falla");
    });
    void cola.encolar(async () => { orden.push("tercera"); });
    await cola.vacia();
    expect(orden).toEqual(["primera", "rota", "tercera"]);
  });
});
