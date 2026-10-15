import { describe, it, expect } from "vitest";
import { consultaDeRespuesta, filtrarRespuestas, insertarRespuesta } from "./respuestas";

const lista = [
  { id: "1", shortcut: "horario", text: "De 9 a 18 h, de lunes a viernes." },
  { id: "2", shortcut: "precios", text: "El plan anual cuesta 120 €." },
  { id: "3", shortcut: "envio-precios", text: "El envío es gratis desde 50 €." },
  { id: "4", shortcut: "gracias", text: "¡Gracias por escribirnos!" },
];

describe("abrir la lista al escribir «/»", () => {
  it("se abre con la barra al principio y sigue lo escrito del atajo", () => {
    expect(consultaDeRespuesta("/", 1)).toEqual({ filtro: "" });
    expect(consultaDeRespuesta("/pre", 4)).toEqual({ filtro: "pre" });
  });

  it("una barra en medio de una frase no la abre", () => {
    expect(consultaDeRespuesta("abierto 24/7", 12)).toBeNull();
    expect(consultaDeRespuesta(" /precios", 9)).toBeNull();
  });

  it("al pasar el atajo, con un espacio, se cierra", () => {
    expect(consultaDeRespuesta("/precios ", 9)).toBeNull();
    // Con el cursor de vuelta en el atajo, se abre otra vez.
    expect(consultaDeRespuesta("/pre para Ana", 4)).toEqual({ filtro: "pre" });
  });
});

describe("qué respuestas ofrece", () => {
  it("primero las que empiezan por lo escrito, luego las que lo contienen", () => {
    expect(filtrarRespuestas(lista, "pre").map((r) => r.shortcut)).toEqual(["precios", "envio-precios"]);
  });

  it("si el atajo no coincide, busca en el texto, sin tildes", () => {
    expect(filtrarRespuestas(lista, "envio").map((r) => r.shortcut)).toEqual(["envio-precios"]);
    expect(filtrarRespuestas(lista, "lunes").map((r) => r.shortcut)).toEqual(["horario"]);
  });

  it("sin filtro, todas (hasta el tope)", () => {
    expect(filtrarRespuestas(lista, "", 3)).toHaveLength(3);
  });
});

describe("insertar la elegida", () => {
  it("sustituye al atajo y deja el cursor al final del texto", () => {
    const r = insertarRespuesta("/pre", 4, lista[1]!);
    expect(r).toEqual({ texto: "El plan anual cuesta 120 €.", cursor: 27 });
  });

  it("lo escrito detrás del atajo se conserva", () => {
    expect(insertarRespuesta("/pre  para Ana", 4, lista[1]!).texto)
      .toBe("El plan anual cuesta 120 €. para Ana");
  });
});
