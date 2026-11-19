import { describe, it, expect } from "vitest";
import { GuardadoAgrupado } from "./guardado.js";

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Un guardado lento que apunta cuántos van en vuelo a la vez y qué guardó. */
function guardadoLento(ms: number, estado: { valor: number }) {
  const r = { enVuelo: 0, maxEnVuelo: 0, guardados: [] as number[], fallarVeces: 0 };
  const guardar = async () => {
    const foto = estado.valor; // se serializa al guardar, como el driver
    r.enVuelo++;
    r.maxEnVuelo = Math.max(r.maxEnVuelo, r.enVuelo);
    await esperar(ms);
    r.enVuelo--;
    if (r.fallarVeces > 0) {
      r.fallarVeces--;
      throw new Error("la base no responde");
    }
    r.guardados.push(foto);
  };
  return { r, guardar };
}

describe("guardado agrupado de credenciales", () => {
  it("una ráfaga de cambios acaba en UNA escritura, con lo último", async () => {
    const estado = { valor: 0 };
    const { r, guardar } = guardadoLento(5, estado);
    const g = new GuardadoAgrupado(guardar, 20, () => {});

    for (let i = 1; i <= 500; i++) {
      estado.valor = i;
      g.marcar();
    }
    await esperar(80);

    expect(r.guardados).toEqual([500]);
  });

  it("nunca hay dos escrituras a la vez, y la última foto es la más reciente", async () => {
    // Es lo que tumbaba el proceso: cientos de copias del almacén en vuelo.
    const estado = { valor: 0 };
    const { r, guardar } = guardadoLento(15, estado);
    const g = new GuardadoAgrupado(guardar, 1, () => {});

    for (let i = 1; i <= 60; i++) {
      estado.valor = i;
      g.marcar();
      await esperar(2);
    }
    await g.vaciar();

    expect(r.maxEnVuelo).toBe(1);
    expect(r.guardados.length).toBeLessThan(20);
    expect(r.guardados.at(-1)).toBe(60);
    // En orden: una foto vieja no puede pisar a una nueva.
    expect([...r.guardados].sort((a, b) => a - b)).toEqual(r.guardados);
  });

  it("vaciar guarda YA sin esperar al plazo", async () => {
    const estado = { valor: 7 };
    const { r, guardar } = guardadoLento(1, estado);
    const g = new GuardadoAgrupado(guardar, 60_000, () => {});

    g.marcar();
    await g.vaciar();

    expect(r.guardados).toEqual([7]);
  });

  it("vaciar con una escritura en curso guarda también lo que llegó después", async () => {
    const estado = { valor: 1 };
    const { r, guardar } = guardadoLento(20, estado);
    const g = new GuardadoAgrupado(guardar, 0, () => {});

    g.marcar();
    await esperar(5); // la primera ya va en vuelo con el valor 1
    estado.valor = 2;
    g.marcar();
    await g.vaciar();

    expect(r.guardados).toEqual([1, 2]);
  });

  it("si la escritura falla, avisa y lo reintenta: no se pierde", async () => {
    const estado = { valor: 3 };
    const { r, guardar } = guardadoLento(1, estado);
    r.fallarVeces = 2;
    const fallos: unknown[] = [];
    const g = new GuardadoAgrupado(guardar, 5, (e) => fallos.push(e));

    g.marcar();
    await esperar(80);

    expect(fallos).toHaveLength(2);
    expect(r.guardados).toEqual([3]);
  });

  it("sin cambios no escribe nada", async () => {
    const { r, guardar } = guardadoLento(1, { valor: 0 });
    const g = new GuardadoAgrupado(guardar, 1, () => {});
    await g.vaciar();
    await esperar(10);
    expect(r.guardados).toEqual([]);
  });
});
