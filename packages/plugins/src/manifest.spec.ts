import { describe, it, expect } from "vitest";
import { compararVersiones, ManifestError, parseManifest } from "./manifest.js";

const base = {
  id: "mi-plugin", name: "Mi plugin", version: "1.0.0", main: "dist/index.js",
};

describe("manifiesto", () => {
  it("acepta uno mínimo y pone los valores por defecto", () => {
    const m = parseManifest(base, "0.1.0");
    expect(m.permissions).toEqual([]);
    expect(m.hooks).toEqual([]);
    expect(m.netAllow).toEqual([]);
  });

  it("rechaza identificadores reservados del núcleo", () => {
    for (const id of ["baileys", "core", "omni", "engine"]) {
      expect(() => parseManifest({ ...base, id }, "0.1.0"), id).toThrow(/reservado/);
    }
  });

  it("rechaza campos desconocidos en vez de ignorarlos", () => {
    // Un campo mal escrito que se ignora en silencio es una función que el
    // autor cree tener y no tiene.
    expect(() => parseManifest({ ...base, permisos: ["messages:send"] }, "0.1.0")).toThrow(ManifestError);
  });

  it("COMPRUEBA la versión mínima del anfitrión, no solo la declara", () => {
    // OpenWA declara `minOpenWAVersion` y documenta que la compatibilidad está
    // «sin gestionar»: entonces el plugin falla en mitad de un mensaje en vez
    // de al instalar.
    expect(() => parseManifest({ ...base, minHostVersion: "2.0.0" }, "1.5.0"))
      .toThrow(/necesita el anfitrión 2\.0\.0/);
    expect(parseManifest({ ...base, minHostVersion: "1.0.0" }, "1.5.0").id).toBe("mi-plugin");
  });

  it("net:fetch sin netAllow no vale, y al revés tampoco", () => {
    // Pedir permiso de red sin decir a dónde es pedir permiso para nada, y casi
    // siempre significa que se olvidó la lista.
    expect(() => parseManifest({ ...base, permissions: ["net:fetch"] }, "0.1.0"))
      .toThrow(/netAllow/);
    expect(() => parseManifest({ ...base, netAllow: ["api.ejemplo.com"] }, "0.1.0"))
      .toThrow(/no sirve de nada/);
  });

  it("rechaza un permiso que no existe", () => {
    expect(() => parseManifest({ ...base, permissions: ["borrar:todo"] }, "0.1.0")).toThrow(ManifestError);
  });

  it("rechaza un gancho que no existe", () => {
    expect(() => parseManifest({ ...base, hooks: ["cuando.me.apetezca"] }, "0.1.0")).toThrow(ManifestError);
  });
});

describe("comparación de versiones", () => {
  it("ordena bien", () => {
    expect(compararVersiones("1.0.0", "1.0.0")).toBe(0);
    expect(compararVersiones("1.2.0", "1.10.0")).toBe(-1);
    expect(compararVersiones("2.0.0", "1.99.99")).toBe(1);
  });

  it("tolera sufijos de prelanzamiento", () => {
    expect(compararVersiones("1.0.0-rc1", "1.0.0")).toBe(0);
  });
});
