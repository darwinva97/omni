import { describe, it, expect } from "vitest";
import { ficheroPegado, type Portapapeles } from "./adjuntar";

const porta = (files: File[], datos: Record<string, string> = {}): Portapapeles => ({
  files, getData: (t) => datos[t] ?? "",
});
const png = (nombre = "image.png") => new File([new Uint8Array([1, 2, 3])], nombre, { type: "image/png" });
const MOMENTO = new Date(2026, 9, 13, 15, 4, 9);

describe("pegar en el campo del mensaje", () => {
  it("pegar texto no adjunta nada: el campo se porta como siempre", () => {
    expect(ficheroPegado(porta([], { "text/plain": "hola" }))).toBeNull();
  });

  it("una captura pegada se adjunta, con un nombre que diga algo", () => {
    const r = ficheroPegado(porta([png()]), MOMENTO);
    expect(r?.file.name).toBe("captura-2026-10-13-150409.png");
    expect(r?.file.type).toBe("image/png");
    expect(r?.omitidos).toBe(0);
  });

  it("un fichero copiado del explorador conserva su nombre y su tipo", () => {
    const pdf = new File(["%PDF"], "Constancia de egresado.pdf", { type: "application/pdf" });
    expect(ficheroPegado(porta([pdf]))?.file).toBe(pdf);
  });

  it("una imagen copiada de una web se adjunta aunque traiga texto", () => {
    // El navegador pone el texto alternativo y un HTML con la <img>.
    const r = ficheroPegado(porta([png("foto.png")], {
      "text/plain": "nutria", "text/html": '<img src="https://x/nutria.png">',
    }));
    expect(r?.file.name).toBe("foto.png");
  });

  it("copiar celdas de Excel pega el TEXTO, no la imagen que las acompaña", () => {
    expect(ficheroPegado(porta([png()], {
      "text/plain": "Martes 20\t7", "text/html": "<table><tr><td>Martes 20</td></tr></table>",
    }))).toBeNull();
  });

  it("si se pegan varios, se adjunta el primero y se dice cuántos quedaron fuera", () => {
    const r = ficheroPegado(porta([png("a.png"), png("b.png"), png("c.png")]));
    expect(r?.file.name).toBe("a.png");
    expect(r?.omitidos).toBe(2);
  });
});
