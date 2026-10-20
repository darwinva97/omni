import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  DATABASE_URL: "postgres://x/y",
  OMNI_MASTER_KEY: "a".repeat(64),
} as NodeJS.ProcessEnv;

describe("configuración por entorno", () => {
  it('"false" apaga de verdad', () => {
    // z.coerce.boolean() daba `true` para la cadena "false": un ajuste de
    // seguridad que se ignora en silencio es peor que no tenerlo.
    const c = loadConfig({ ...base, SANDBOX_ENABLED: "false", MCP_ENABLED: "false" });
    expect(c.SANDBOX_ENABLED).toBe(false);
    expect(c.MCP_ENABLED).toBe(false);
  });

  it('"true" enciende', () => {
    expect(loadConfig({ ...base, MCP_ENABLED: "true" }).MCP_ENABLED).toBe(true);
  });

  it("acepta las formas habituales en ambos idiomas", () => {
    for (const v of ["1", "yes", "on", "si", "TRUE", " True "]) {
      expect(loadConfig({ ...base, MCP_ENABLED: v }).MCP_ENABLED, v).toBe(true);
    }
    for (const v of ["0", "no", "off", "FALSE", " false "]) {
      expect(loadConfig({ ...base, MCP_ENABLED: v }).MCP_ENABLED, v).toBe(false);
    }
  });

  it("no arranca sin contraseña y sin proveedor OIDC: nadie podría entrar", () => {
    expect(() => loadConfig({ ...base, PASSWORD_LOGIN_ENABLED: "false" })).toThrow(/OIDC_ISSUER_URL/);
    const c = loadConfig({
      ...base, PASSWORD_LOGIN_ENABLED: "false",
      OIDC_ISSUER_URL: "https://idp.ejemplo.com/realms/r", OIDC_CLIENT_ID: "omni", OIDC_CLIENT_SECRET: "s",
    });
    expect(c.PASSWORD_LOGIN_ENABLED).toBe(false);
    expect(c.OIDC_SESSION_HOURS).toBe(12);
  });

  it("respeta los valores por defecto", () => {
    const c = loadConfig(base);
    expect(c.SANDBOX_ENABLED).toBe(true);
    expect(c.MCP_ENABLED).toBe(false);
    // El servidor MCP nace de solo lectura: dar escritura es una decisión.
    expect(c.MCP_READONLY).toBe(true);
  });

  it("rechaza un booleano que no se entiende en vez de inventárselo", () => {
    expect(() => loadConfig({ ...base, MCP_ENABLED: "quizás" })).toThrow(/booleano/);
  });

  it("exige una clave maestra suficientemente larga", () => {
    expect(() => loadConfig({ ...base, OMNI_MASTER_KEY: "corta" })).toThrow(/OMNI_MASTER_KEY/);
  });
});
