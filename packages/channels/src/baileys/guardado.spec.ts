import { describe, it, expect } from "vitest";
import { guardadoAgrupado } from "./guardado.js";

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("guardado agrupado de la sesión", () => {
  it("muchos cambios seguidos se guardan una vez, con lo último", async () => {
    let version = 0;
    const guardados: number[] = [];
    const g = guardadoAgrupado(
      () => new Uint8Array([version]),
      async (b) => void guardados.push(b[0]!),
      20,
    );
    for (let i = 1; i <= 50; i++) {
      version = i;
      g.cambio();
    }
    await espera(60);
    expect(guardados).toEqual([50]);
  });

  it("de uno en uno: una escritura lenta no la pisa otra más vieja", async () => {
    let version = 0;
    const guardados: number[] = [];
    let lentos = 0;
    const g = guardadoAgrupado(
      () => new Uint8Array([version]),
      async (b) => {
        if (lentos++ === 0) await espera(50);
        guardados.push(b[0]!);
      },
      5,
    );
    version = 1;
    g.cambio();
    await espera(15);
    version = 2;
    g.cambio();
    await espera(120);
    expect(guardados).toEqual([1, 2]);
  });

  it("vaciar guarda ya lo pendiente (al desconectar)", async () => {
    const guardados: number[] = [];
    const g = guardadoAgrupado(() => new Uint8Array([7]), async (b) => void guardados.push(b[0]!), 10_000);
    g.cambio();
    await g.vaciar();
    expect(guardados).toEqual([7]);
  });
});
