import { describe, it, expect } from "vitest";
import {
  agregarAdjuntos, ficherosPegados, MAX_ADJUNTOS, MAX_BYTES, type Portapapeles,
} from "./adjuntar";

const porta = (files: File[], datos: Record<string, string> = {}): Portapapeles => ({
  files, getData: (t) => datos[t] ?? "",
});
const png = (nombre = "image.png", modificado = 1) =>
  new File([new Uint8Array([1, 2, 3])], nombre, { type: "image/png", lastModified: modificado });
const MOMENTO = new Date(2026, 9, 13, 15, 4, 9);

describe("pegar en el campo del mensaje", () => {
  it("pegar texto no adjunta nada: el campo se porta como siempre", () => {
    expect(ficherosPegados(porta([], { "text/plain": "hola" }))).toEqual([]);
  });

  it("una captura pegada se adjunta, con un nombre que diga algo", () => {
    const [f] = ficherosPegados(porta([png()]), MOMENTO);
    expect(f?.name).toBe("captura-2026-10-13-150409.png");
    expect(f?.type).toBe("image/png");
  });

  it("varias capturas a la vez no se llaman igual", () => {
    const nombres = ficherosPegados(porta([png(), png()]), MOMENTO).map((f) => f.name);
    expect(nombres).toEqual([
      "captura-2026-10-13-150409-1.png", "captura-2026-10-13-150409-2.png",
    ]);
  });

  it("los ficheros copiados del explorador entran TODOS, con su nombre", () => {
    const pdf = new File(["%PDF"], "Constancia.pdf", { type: "application/pdf" });
    const foto = png("nutria.png");
    expect(ficherosPegados(porta([pdf, foto]))).toEqual([pdf, foto]);
  });

  it("una imagen copiada de una web se adjunta aunque traiga texto", () => {
    const [f] = ficherosPegados(porta([png("foto.png")], {
      "text/plain": "nutria", "text/html": '<img src="https://x/nutria.png">',
    }));
    expect(f?.name).toBe("foto.png");
  });

  it("copiar celdas de Excel pega el TEXTO, no la imagen que las acompaña", () => {
    expect(ficherosPegados(porta([png()], {
      "text/plain": "Martes 20\t7", "text/html": "<table><tr><td>Martes 20</td></tr></table>",
    }))).toEqual([]);
  });
});

describe("la tira de adjuntos", () => {
  let n = 0;
  const id = () => `a${++n}`;

  it("añade en orden, cada uno con su tipo y sin pie", () => {
    const pdf = new File(["%PDF"], "c.pdf", { type: "application/pdf" });
    const { lista, avisos } = agregarAdjuntos([], [png("a.png"), pdf], id);
    expect(lista.map((a) => [a.file.name, a.campo, a.pie])).toEqual([
      ["a.png", "image", ""], ["c.pdf", "document", ""],
    ]);
    expect(avisos).toEqual([]);
  });

  it("lo que pesa demasiado se rechaza diciéndolo, y el resto entra", () => {
    const enorme = new File([new Uint8Array(1)], "video.mp4", { type: "video/mp4" });
    Object.defineProperty(enorme, "size", { value: MAX_BYTES + 1 });
    const { lista, avisos } = agregarAdjuntos([], [enorme, png("b.png")], id);
    expect(lista.map((a) => a.file.name)).toEqual(["b.png"]);
    expect(avisos[0]).toContain("video.mp4");
  });

  it("el mismo fichero dos veces no se duplica", () => {
    const f = png("a.png", 7);
    const primero = agregarAdjuntos([], [f], id).lista;
    expect(agregarAdjuntos(primero, [f], id).lista).toHaveLength(1);
  });

  it("no pasa del máximo, y dice cuáles se quedaron fuera", () => {
    const muchos = Array.from({ length: MAX_ADJUNTOS + 2 }, (_, i) => png(`f${i}.png`, i));
    const { lista, avisos } = agregarAdjuntos([], muchos, id);
    expect(lista).toHaveLength(MAX_ADJUNTOS);
    expect(avisos[0]).toContain(`f${MAX_ADJUNTOS}.png`);
  });
});
