import { describe, it, expect } from "vitest";
import { parseAddress, tryParseAddress, sameAddress, AddressError, isGroup } from "./address.js";

describe("parseAddress", () => {
  it("normaliza las dos formas de individuo a la misma dirección", () => {
    // Baileys usa @s.whatsapp.net, whatsapp-web.js usa @c.us: es la misma persona.
    const a = parseAddress("51999888777@s.whatsapp.net");
    const b = parseAddress("51999888777@c.us");
    expect(sameAddress(a, b)).toBe(true);
    expect(a.value).toBe("51999888777@s.whatsapp.net");
  });

  it("acepta un teléfono desnudo y lo canoniza", () => {
    expect(parseAddress("+51 999 888 777").value).toBe("51999888777@s.whatsapp.net");
  });

  it("descarta el sufijo de dispositivo que añade Baileys", () => {
    expect(parseAddress("51999888777:12@s.whatsapp.net").local).toBe("51999888777");
  });

  it("reconoce grupos, newsletters y LIDs", () => {
    expect(parseAddress("12036304-1599999999@g.us").kind).toBe("group");
    expect(isGroup(parseAddress("12036304-1599999999@g.us"))).toBe(true);
    expect(parseAddress("1203630@newsletter").kind).toBe("newsletter");
    expect(parseAddress("46274715893950@lid").kind).toBe("lid");
  });

  it("NO confunde los dígitos de un LID con un teléfono", () => {
    // La regla que impide una fuga de aislamiento entre dos personas distintas.
    const lid = parseAddress("555000111@lid");
    const pn = parseAddress("555000111@s.whatsapp.net");
    expect(sameAddress(lid, pn)).toBe(false);
    expect(lid.kind).toBe("lid");
    expect(pn.kind).toBe("pn");
  });

  it("rechaza lo ambiguo en vez de adivinar", () => {
    expect(() => parseAddress("pepito")).toThrow(AddressError);
    expect(() => parseAddress("")).toThrow(AddressError);
    expect(() => parseAddress("123@desconocido")).toThrow(AddressError);
    expect(tryParseAddress("pepito")).toBeNull();
  });

  it("reconoce correo electrónico para el canal de email", () => {
    expect(parseAddress("Ada@Example.COM").kind).toBe("email");
    expect(parseAddress("Ada@Example.COM").value).toBe("ada@example.com");
  });
});
