import { describe, it, expect } from "vitest";
import { iniciales } from "./formato";

describe("iniciales del círculo", () => {
  it("un emoji delante no se parte por la mitad", () => {
    // Se vio en la lista: «🟣 SETIEMBRE 5…» salía como «�5».
    expect(iniciales("🟣 SETIEMBRE 5 - 2026 - AUXILIAR")).toBe("S5");
    expect(iniciales("Amorcitoooo Bella 💞")).toBe("AB");
  });

  it("un nombre que es solo emoji no da iniciales: se pinta el icono", () => {
    expect(iniciales("💞🟣")).toBe("");
  });

  it("los casos de siempre siguen igual", () => {
    expect(iniciales("Darwin Vilcachagua")).toBe("DV");
    expect(iniciales("Familia")).toBe("FA");
    expect(iniciales("+51 936 854 713")).toBe("");
    expect(iniciales("Ñandú ágil")).toBe("ÑÁ");
  });
});
