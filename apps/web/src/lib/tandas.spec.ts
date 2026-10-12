import { describe, it, expect } from "vitest";
import { abreTanda } from "./tandas";

const de = (quien: string | null, extra: Record<string, unknown> = {}) => ({
  fromMe: quien === null, senderAddress: quien, kind: "text", body: "x", deleted: false,
  ...extra,
});

describe("dónde empieza cada tanda", () => {
  it("el caso de Burrakitos: cada cambio de persona abre tanda", () => {
    // Rodrigo, aimet, aimet, Rodrigo, Rodrigo, Esteban, Esteban(sticker).
    const hilo = [
      de("rodrigo@lid"), de("aimet@lid"), de("aimet@lid"),
      de("rodrigo@lid"), de("rodrigo@lid"),
      de("esteban@lid"), de("esteban@lid", { kind: "sticker", body: null }),
    ];
    const abre = hilo.map((m, i) => abreTanda(hilo[i - 1], m, true));
    expect(abre).toEqual([true, true, false, true, false, true, false]);
  });

  it("en un chat de dos, lo ajeno es una sola persona", () => {
    const hilo = [de("a@lid"), de("b@lid")];
    expect(abreTanda(hilo[0], hilo[1]!, false)).toBe(false);
  });

  it("propio y ajeno siempre son tandas distintas", () => {
    expect(abreTanda(de(null), de("a@lid"), true)).toBe(true);
    expect(abreTanda(de("a@lid"), de(null), true)).toBe(true);
    expect(abreTanda(de(null), de(null), true)).toBe(false);
  });

  it("después de un aviso del sistema se empieza de nuevo", () => {
    const aviso = de("a@lid", { kind: "unknown", body: null });
    expect(abreTanda(aviso, de("a@lid"), true)).toBe(true);
  });
});
