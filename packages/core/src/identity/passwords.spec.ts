import { describe, it, expect } from "vitest";
import { generateToken, hashPassword, hashToken, verifyPassword, PasswordError } from "./passwords.js";

describe("contraseñas", () => {
  it("verifica la correcta y rechaza la incorrecta", async () => {
    const h = await hashPassword("una contraseña larga de verdad");
    expect(await verifyPassword("una contraseña larga de verdad", h)).toBe(true);
    expect(await verifyPassword("otra contraseña larga aquí", h)).toBe(false);
  });

  it("dos hashes de la misma contraseña son distintos", async () => {
    // Si fueran iguales, quien vea la base sabría quién comparte contraseña.
    const a = await hashPassword("la misma contraseña larga");
    const b = await hashPassword("la misma contraseña larga");
    expect(a).not.toBe(b);
    expect(await verifyPassword("la misma contraseña larga", b)).toBe(true);
  });

  it("lleva la versión dentro, para poder subir los parámetros después", async () => {
    expect(await hashPassword("una contraseña larga de verdad")).toMatch(/^s1\$/);
  });

  it("exige una longitud mínima", async () => {
    await expect(hashPassword("corta")).rejects.toThrow(PasswordError);
  });

  it("un hash corrupto no revienta: devuelve false", async () => {
    expect(await verifyPassword("x", "basura")).toBe(false);
    expect(await verifyPassword("x", "s1$no-es-base64$tampoco")).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
  });
});

describe("tokens", () => {
  it("son largos y nunca se repiten", () => {
    const vistos = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(vistos.size).toBe(200);
    expect([...vistos][0]!.length).toBeGreaterThanOrEqual(43);
  });

  it("el hash es estable y no contiene el token", async () => {
    const t = generateToken();
    expect(await hashToken(t)).toBe(await hashToken(t));
    expect(await hashToken(t)).not.toContain(t);
  });
});
