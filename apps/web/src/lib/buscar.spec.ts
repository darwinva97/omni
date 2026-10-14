import { describe, it, expect } from "vitest";
import { fragmentoConCoincidencia } from "./buscar";

describe("resaltar lo buscado", () => {
  it("marca el trozo ORIGINAL, con su tilde, aunque se buscara sin ella", () => {
    expect(fragmentoConCoincidencia("Mañana te paso la CANCIÓN", "cancion")).toEqual({
      antes: "Mañana te paso la ", coincide: "CANCIÓN", despues: "",
    });
  });

  it("recorta lo de delante si la coincidencia está lejos", () => {
    const largo = `${"x".repeat(80)} aquí está`;
    const r = fragmentoConCoincidencia(largo, "aqui", 10);
    expect(r.antes.startsWith("…")).toBe(true);
    expect(r.coincide).toBe("aquí");
  });

  it("los emojis no descolocan la posición", () => {
    expect(fragmentoConCoincidencia("💞 hola Ana", "ana").coincide).toBe("Ana");
  });

  it("sin coincidencia, el texto entero", () => {
    expect(fragmentoConCoincidencia("nada", "zzz")).toEqual({ antes: "nada", coincide: "", despues: "" });
  });
});
