import { describe, it, expect } from "vitest";
import { bonito, leerTelefono, pareceTelefono, prefijoDe } from "./telefono";

const LINEA = "51999888777@s.whatsapp.net";

describe("¿es un teléfono?", () => {
  it("cifras con los signos de siempre, sí; un nombre o un número corto, no", () => {
    expect(pareceTelefono("+51 987 654 321")).toBe(true);
    expect(pareceTelefono("(01) 234-5678")).toBe(true);
    expect(pareceTelefono("Lucía")).toBe(false);
    expect(pareceTelefono("4471")).toBe(false);
    expect(pareceTelefono("pedido 4471123")).toBe(false);
  });
});

describe("leer un teléfono", () => {
  it("con + o con 00 es internacional, tal cual", () => {
    expect(leerTelefono("+34 612-345-678", LINEA)).toMatchObject({ ok: true, numero: "34612345678", prefijoSupuesto: null });
    expect(leerTelefono("0034 612 345 678", LINEA)).toMatchObject({ ok: true, numero: "34612345678" });
  });

  it("sin prefijo y largo, se da por internacional sin el +", () => {
    expect(leerTelefono("51987654321", LINEA)).toMatchObject({ ok: true, numero: "51987654321", prefijoSupuesto: null });
  });

  it("sin prefijo y nacional, se le pone el de la línea y se dice", () => {
    expect(leerTelefono("987 654 321", LINEA)).toMatchObject({
      ok: true, numero: "51987654321", prefijoSupuesto: "51", bonito: "+51 987 654 321",
    });
    // El 0 de larga distancia sobra delante del prefijo de país.
    expect(leerTelefono("01 234 5678", LINEA)).toMatchObject({ ok: true, numero: "5112345678" });
  });

  it("sin prefijo y sin número en la línea, no se adivina", () => {
    expect(leerTelefono("987654321", null).ok).toBe(false);
  });

  it("demasiado largo no es un teléfono", () => {
    expect(leerTelefono("+51 9876 5432 1098 7654", LINEA).ok).toBe(false);
  });
});

describe("prefijos de país", () => {
  it("de una, dos y tres cifras", () => {
    expect(prefijoDe("12025550123")).toBe("1");
    expect(prefijoDe("34612345678")).toBe("34");
    expect(prefijoDe("593987654321")).toBe("593");
    expect(bonito("593987654321")).toBe("+593 987 654 321");
  });
});
