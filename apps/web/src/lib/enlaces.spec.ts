import { describe, it, expect } from "vitest";
import { partirEnlaces } from "./enlaces";

const enlaces = (t: string) => partirEnlaces(t)
  .filter((x): x is { enlace: string; href: string } => "enlace" in x);

describe("enlaces en un mensaje", () => {
  it("con https, tal cual, y el texto alrededor intacto", () => {
    expect(partirEnlaces("mira https://forms.gle/abc123 y me dices")).toEqual([
      { texto: "mira " },
      { enlace: "https://forms.gle/abc123", href: "https://forms.gle/abc123" },
      { texto: " y me dices" },
    ]);
  });

  it("el punto o la coma del final no son del enlace", () => {
    expect(enlaces("Entra aquí: https://smartdata.com.pe/blog.")[0]?.enlace)
      .toBe("https://smartdata.com.pe/blog");
    expect(enlaces("https://a.com/x, https://b.com/y")).toHaveLength(2);
  });

  it("un paréntesis de cierre solo es suyo si lo abrió él", () => {
    expect(enlaces("(ver https://es.wikipedia.org/wiki/Lima)")[0]?.enlace)
      .toBe("https://es.wikipedia.org/wiki/Lima");
    expect(enlaces("https://es.wikipedia.org/wiki/Lima_(Perú)")[0]?.enlace)
      .toBe("https://es.wikipedia.org/wiki/Lima_(Perú)");
  });

  it("con formato de WhatsApp alrededor: *https://x.com*", () => {
    expect(enlaces("*https://x.com/promo*")[0]?.enlace).toBe("https://x.com/promo");
  });

  it("«Https://» con mayúscula —el corrector del teléfono— también, normalizado", () => {
    expect(enlaces("Https://infanti.com.pe/products/x")[0]).toEqual({
      enlace: "Https://infanti.com.pe/products/x", href: "https://infanti.com.pe/products/x",
    });
  });

  it("www. y los dominios sueltos conocidos se abren con https", () => {
    expect(enlaces("www.instagram.com/reel/DeHY")[0]?.href)
      .toBe("https://www.instagram.com/reel/DeHY");
    expect(enlaces("pásate por smartdata.com.pe/blog hoy")[0]).toEqual({
      enlace: "smartdata.com.pe/blog", href: "https://smartdata.com.pe/blog",
    });
  });

  it("un correo es mailto, y no se confunde con un dominio", () => {
    expect(enlaces("escribe a grados@isam.edu.pe")).toEqual([
      { enlace: "grados@isam.edu.pe", href: "mailto:grados@isam.edu.pe" },
    ]);
  });

  it("lo que solo se parece a un dominio se queda en texto", () => {
    expect(enlaces("usa node.js, abre archivo.txt, pi es 3.14")).toEqual([]);
  });

  it("una mención no es un enlace", () => {
    expect(enlaces("@120238196658384 hola")).toEqual([]);
  });

  it("nada que se escriba llega al href tal cual: javascript: se queda en texto", () => {
    expect(enlaces("javascript:alert(1)")).toEqual([]);
  });
});
