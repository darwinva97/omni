import { describe, it, expect } from "vitest";
import { checkUrl, CapabilityDenied, requireCapability } from "./capabilities.js";
import { parseManifest, type Manifest } from "../manifest.js";

const conPermisos = (permissions: string[], netAllow: string[] = []): Manifest =>
  parseManifest(
    { id: "pl", name: "P", version: "1.0.0", main: "i.js", permissions, netAllow },
    "1.0.0",
  );

describe("capacidades", () => {
  it("deja pasar lo declarado y corta lo demás", () => {
    const m = conPermisos(["messages:read"]);
    expect(() => requireCapability(m, "messages:read")).not.toThrow();
    expect(() => requireCapability(m, "messages:send")).toThrow(CapabilityDenied);
  });

  it("el error dice QUÉ capacidad faltaba, no solo que falta una", () => {
    const err = (() => {
      try { requireCapability(conPermisos([]), "labels:manage"); return null; }
      catch (e) { return e as CapabilityDenied; }
    })();
    expect(err?.status).toBe(403);
    expect(err?.message).toContain("labels:manage");
    expect(err?.details["pluginId"]).toBe("pl");
  });
});

describe("lista de dominios", () => {
  const m = conPermisos(["net:fetch"], ["api.ejemplo.com", "*.interno.dev"]);

  it("deja el dominio exacto y los subdominios declarados", () => {
    expect(checkUrl(m, "https://api.ejemplo.com/x").hostname).toBe("api.ejemplo.com");
    expect(checkUrl(m, "https://a.interno.dev/x").hostname).toBe("a.interno.dev");
  });

  it("un comodín NO cubre el dominio desnudo", () => {
    // Quien quiera los dos, que declare los dos: es más ruidoso y más claro.
    expect(() => checkUrl(m, "https://interno.dev/x")).toThrow(/netAllow/);
  });

  it("corta lo que no está en la lista", () => {
    expect(() => checkUrl(m, "https://otro.com/x")).toThrow(/netAllow/);
  });

  it("corta las direcciones internas AUNQUE estén en la lista", () => {
    // Sin esto, un plugin declara `netAllow` con un nombre que resuelve dentro
    // y usa el servidor de puente hacia la red interna.
    const abierto = conPermisos(["net:fetch"], ["localhost", "169.254.169.254", "10.0.0.5"]);
    for (const u of [
      "http://localhost/x", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/x",
    ]) {
      expect(() => checkUrl(abierto, u), u).toThrow(/internas/);
    }
  });

  it("corta esquemas que no son http", () => {
    expect(() => checkUrl(m, "file:///etc/passwd")).toThrow(/esquema/);
  });
});
