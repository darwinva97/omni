import { describe, it, expect } from "vitest";
import {
  consultaDeMencion, filtrarParticipantes, insertarMencion, prepararMenciones,
} from "./menciones";

describe("abrir la lista al escribir «@»", () => {
  it("se abre con «@» al principio o tras un espacio, y sigue lo escrito", () => {
    expect(consultaDeMencion("@", 1)).toEqual({ inicio: 0, filtro: "" });
    expect(consultaDeMencion("hola @Ro", 8)).toEqual({ inicio: 5, filtro: "Ro" });
  });

  it("el «@» de un correo no la abre", () => {
    expect(consultaDeMencion("hola@empresa", 12)).toBeNull();
  });

  it("un espacio después del nombre la cierra", () => {
    expect(consultaDeMencion("@Ro ", 4)).toBeNull();
  });

  it("mira lo que hay ANTES del cursor, no el final del texto", () => {
    expect(consultaDeMencion("hola @Ro y adiós", 8)).toEqual({ inicio: 5, filtro: "Ro" });
  });
});

describe("a quién ofrece", () => {
  const gente = [
    { address: "1@lid", name: "Rodrigo Chumpitaz" },
    { address: "2@lid", name: "Ángela Ruiz" },
    { address: "3@lid", name: "Esteban Dmd" },
    { address: "4@lid", name: "Darwin", me: true },
  ];

  it("por el principio de cualquier palabra, sin tildes ni mayúsculas", () => {
    expect(filtrarParticipantes(gente, "chu").map((p) => p.name)).toEqual(["Rodrigo Chumpitaz"]);
    expect(filtrarParticipantes(gente, "ang").map((p) => p.name)).toEqual(["Ángela Ruiz"]);
  });

  it("primero lo que empieza así, luego lo que lo contiene", () => {
    expect(filtrarParticipantes(gente, "r").map((p) => p.name))
      .toEqual(["Rodrigo Chumpitaz", "Ángela Ruiz"]);
  });

  it("nunca a uno mismo", () => {
    expect(filtrarParticipantes(gente, "dar")).toEqual([]);
    expect(filtrarParticipantes(gente, "")).toHaveLength(3);
  });
});

describe("insertar y mandar", () => {
  it("cambia lo que se estaba escribiendo por el nombre y deja el cursor detrás", () => {
    expect(insertarMencion("hola @Ro y", 5, 8, "Rodrigo Chumpitaz"))
      .toEqual({ texto: "hola @Rodrigo Chumpitaz  y", cursor: 24 });
  });

  it("al enviar, el nombre pasa a ser el número y la dirección va aparte", () => {
    const r = prepararMenciones(
      "@Rodrigo Chumpitaz me yapeas?",
      new Map([["Rodrigo Chumpitaz", "248975076663346@lid"]]),
    );
    expect(r.texto).toBe("@248975076663346 me yapeas?");
    expect(r.mentions).toEqual(["248975076663346@lid"]);
    expect(r.menciones).toEqual([{ token: "248975076663346", name: "Rodrigo Chumpitaz" }]);
  });

  it("el nombre más largo primero: «@Ana María» no se queda en «@Ana»", () => {
    const r = prepararMenciones("@Ana María y @Ana", new Map([
      ["Ana", "1@lid"], ["Ana María", "2@lid"],
    ]));
    expect(r.texto).toBe("@2 y @1");
    expect(r.mentions.sort()).toEqual(["1@lid", "2@lid"]);
  });

  it("solo el nombre entero: «@Anabel» no menciona a Ana", () => {
    const r = prepararMenciones("@Anabel hola", new Map([["Ana", "1@lid"]]));
    expect(r.texto).toBe("@Anabel hola");
    expect(r.mentions).toEqual([]);
  });

  it("si se borró la mención antes de enviar, no se manda", () => {
    expect(prepararMenciones("hola", new Map([["Ana", "1@lid"]])).mentions).toEqual([]);
  });
});
