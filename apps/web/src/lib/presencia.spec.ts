import { describe, it, expect } from "vitest";
import { aplicarPresencia, CADUCA_MS, describir, type Presencias } from "./presencia";

const T = 1_700_000_000_000;
const vacio: Presencias = new Map();
const ev = (chat: string, ...estados: [string, string, string][]) => ({
  chat, estados: estados.map(([address, name, state]) => ({ address, name, state })),
});

describe("el «escribiendo…»", () => {
  it("en un chat de dos no se dice quién", () => {
    const p = aplicarPresencia(vacio, ev("ana@lid", ["ana@lid", "Ana", "composing"]), T);
    expect(describir(p, "ana@lid", false, T)).toEqual({ texto: "escribiendo…", activo: true });
  });

  it("en un grupo se dice quién, por su nombre de pila", () => {
    const p = aplicarPresencia(vacio, ev("g@g.us", ["r@lid", "Rodrigo Chumpitaz", "composing"]), T);
    expect(describir(p, "g@g.us", true, T)?.texto).toBe("Rodrigo está escribiendo…");
  });

  it("dos se nombran; tres o más se cuentan", () => {
    let p = aplicarPresencia(vacio, ev("g@g.us",
      ["r@lid", "Rodrigo", "composing"], ["a@lid", "Ana", "composing"]), T);
    expect(describir(p, "g@g.us", true, T)?.texto).toBe("Rodrigo y Ana están escribiendo…");
    p = aplicarPresencia(p, ev("g@g.us", ["e@lid", "Esteban", "composing"]), T);
    expect(describir(p, "g@g.us", true, T)?.texto).toBe("3 personas están escribiendo…");
  });

  it("grabar gana a escribir", () => {
    const p = aplicarPresencia(vacio, ev("g@g.us",
      ["r@lid", "Rodrigo", "composing"], ["a@lid", "Ana", "recording"]), T);
    expect(describir(p, "g@g.us", true, T)?.texto).toBe("Ana está grabando audio…");
  });

  it("«paused» lo apaga, y sin él caduca solo", () => {
    let p = aplicarPresencia(vacio, ev("ana@lid", ["ana@lid", "Ana", "composing"]), T);
    expect(describir(aplicarPresencia(p, ev("ana@lid", ["ana@lid", "Ana", "paused"]), T + 1000),
      "ana@lid", false, T + 1000)?.activo).toBe(false);
    // Cerró la aplicación a mitad de frase: el «paused» no llega nunca.
    expect(describir(p, "ana@lid", false, T + CADUCA_MS + 1)?.texto).toBe("en línea");
    // Renovado, sigue.
    p = aplicarPresencia(p, ev("ana@lid", ["ana@lid", "Ana", "composing"]), T + CADUCA_MS - 1000);
    expect(describir(p, "ana@lid", false, T + CADUCA_MS + 1)?.activo).toBe(true);
  });

  it("sin nadie escribiendo, en un chat de dos se dice si está en línea o cuándo se fue", () => {
    let p = aplicarPresencia(vacio, ev("ana@lid", ["ana@lid", "Ana", "available"]), T);
    expect(describir(p, "ana@lid", false, T)?.texto).toBe("en línea");
    p = aplicarPresencia(p, ev("ana@lid", ["ana@lid", "Ana", "unavailable"]), T);
    expect(describir(p, "ana@lid", false, T)?.texto).toMatch(/^últ\. vez hoy a las/);
  });

  it("en un grupo, sin nadie escribiendo, no se dice nada", () => {
    const p = aplicarPresencia(vacio, ev("g@g.us", ["r@lid", "Rodrigo", "available"]), T);
    expect(describir(p, "g@g.us", true, T)).toBeNull();
  });

  it("lo de un chat no se cuela en otro", () => {
    const p = aplicarPresencia(vacio, ev("ana@lid", ["ana@lid", "Ana", "composing"]), T);
    expect(describir(p, "otro@lid", false, T)).toBeNull();
  });
});
