import { describe, it, expect } from "vitest";
import { claveDe, conBorrador, leerMapa, MAX_BORRADORES, resumenDeBorrador } from "./borradores";

describe("borradores por conversación", () => {
  const k = claveDe("linea-1", "51988777666@s.whatsapp.net");

  it("la misma dirección en dos líneas son dos borradores", () => {
    expect(claveDe("linea-1", "x@s.whatsapp.net")).not.toBe(claveDe("linea-2", "x@s.whatsapp.net"));
  });

  it("guarda lo escrito y lo quita al vaciarse", () => {
    const con = conBorrador({}, k, { texto: "hola, mira", en: 1 });
    expect(con[k]?.texto).toBe("hola, mira");
    // Solo espacios no es un borrador: la lista dejaría «Borrador:» sin nada.
    expect(conBorrador(con, k, { texto: "   ", en: 2 })).toEqual({});
    expect(conBorrador(con, k, null)).toEqual({});
  });

  it("una cita sin texto sigue siendo un borrador", () => {
    const cita = {
      id: "m1", providerMessageId: "P1", fromMe: false, kind: "text",
      body: "¿precio?", state: "delivered", timestamp: "2026-10-15T10:00:00Z",
    };
    const con = conBorrador({}, k, { texto: "", cita, en: 1 });
    expect(con[k]?.cita?.id).toBe("m1");
    expect(resumenDeBorrador(con[k]!)).toBe("respondiendo a un mensaje");
  });

  it("si se pasa del tope se van los más viejos, nunca el que se escribe", () => {
    let mapa = {};
    for (let i = 0; i < MAX_BORRADORES; i++) {
      mapa = conBorrador(mapa, claveDe("l", `${i}@s.whatsapp.net`), { texto: "x", en: 1000 + i });
    }
    // El nuevo tiene una marca MÁS VIEJA que todos (reloj cambiado, otra
    // pestaña): aun así se queda, y sale el más viejo de los demás.
    const nuevo = claveDe("l", "nuevo@s.whatsapp.net");
    const final = conBorrador(mapa, nuevo, { texto: "y", en: 1 });
    expect(Object.keys(final)).toHaveLength(MAX_BORRADORES);
    expect(final[nuevo]).toBeDefined();
    expect(final[claveDe("l", "0@s.whatsapp.net")]).toBeUndefined();
  });

  it("lo guardado roto no rompe el panel", () => {
    expect(leerMapa("{no es json")).toEqual({});
    expect(leerMapa("[1,2]")).toEqual({});
    expect(leerMapa(null)).toEqual({});
  });

  it("el adelanto es una línea", () => {
    expect(resumenDeBorrador({ texto: "  hola\n\nqué tal  ", en: 1 })).toBe("hola qué tal");
  });
});
