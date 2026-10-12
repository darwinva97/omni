import { describe, it, expect } from "vitest";
import { conNombres, nombreVisible, tokensDeMencion } from "./nombres.js";

const LID = "120238196658384@lid";
const PN = "51952631806@s.whatsapp.net";

describe("qué nombre se enseña", () => {
  it("1. el de tu agenda gana a todo", () => {
    expect(nombreVisible({
      address: LID, savedName: "Raquel (trabajo)", pushName: "Nadkym",
      username: "nadkym", phone: PN,
    })).toBe("Raquel (trabajo)");
  });

  it("2. sin agenda, el que esa persona se puso", () => {
    expect(nombreVisible({
      address: LID, pushName: "Nadkym", username: "nadkym", phone: PN,
    })).toBe("Nadkym");
  });

  it("3. sin ninguno de los dos, su @usuario de WhatsApp", () => {
    expect(nombreVisible({ address: LID, username: "nadkym", phone: PN })).toBe("@nadkym");
    // Sin arroba doble si ya viene con ella.
    expect(nombreVisible({ address: LID, username: "@nadkym" })).toBe("@nadkym");
  });

  it("4. sin nombres, su número", () => {
    expect(nombreVisible({ address: LID, phone: PN })).toBe("+51952631806");
    // Una dirección de teléfono ES su número.
    expect(nombreVisible({ address: PN })).toBe("+51952631806");
  });

  it("5. y solo si no hay nada, el identificador, SIN `+`", () => {
    /*
     * Los dígitos de un LID no son un teléfono. Antes dos sitios los
     * enseñaban como `+120238196658384`, que es invitar a marcarlos.
     */
    expect(nombreVisible({ address: LID })).toBe("120238196658384");
  });

  it("un nombre en blanco no cuenta: se pasa al siguiente", () => {
    expect(nombreVisible({ address: LID, savedName: "  ", pushName: "Nadkym" })).toBe("Nadkym");
  });

  it("el sufijo de dispositivo no se cuela en el número", () => {
    expect(nombreVisible({ address: "51952631806:25@s.whatsapp.net" })).toBe("+51952631806");
  });
});

describe("menciones", () => {
  it("encuentra cada número mencionado, una vez", () => {
    expect(tokensDeMencion("@120238196658384 raquel, y @120238196658384 otra vez @34926808301794"))
      .toEqual(["120238196658384", "34926808301794"]);
  });

  it("no confunde un correo ni un número suelto con una mención", () => {
    expect(tokensDeMencion("escribe a hola@empresa.com o al 999888777")).toEqual([]);
  });

  it("pone el nombre donde se sabe y deja el número donde no", () => {
    // Inventar a quién apunta una mención sería peor que enseñar el número.
    expect(conNombres(
      "@120238196658384 porfa, y @11111111 también",
      new Map([["120238196658384", "Nadkym"]]),
    )).toBe("@Nadkym porfa, y @11111111 también");
  });

  it("un @usuario no sale con arroba doble", () => {
    expect(conNombres("@120238196658384 hola", { "120238196658384": "@nadkym" }))
      .toBe("@nadkym hola");
  });
});
