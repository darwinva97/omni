import { describe, expect, it } from "vitest";
import { aIdentificador } from "./identificador";

describe("aIdentificador", () => {
  it("deja sólo minúsculas, números y guiones", () => {
    expect(aIdentificador("Mi Tienda Perú")).toBe("mi-tienda-peru");
    expect(aIdentificador("  ventas_2 / WhatsApp ")).toBe("ventas-2-whatsapp");
    expect(aIdentificador("ya-bien")).toBe("ya-bien");
  });
  it("vacío si no queda nada, y como mucho 60", () => {
    expect(aIdentificador("¿¡!?")).toBe("");
    expect(aIdentificador("a".repeat(80))).toHaveLength(60);
  });
});
