import { describe, it, expect } from "vitest";
import { mintApiKey, parseApiKey, verifySecret } from "./keys.js";

describe("claves de API", () => {
  it("acuña una clave usable y verificable", async () => {
    const k = await mintApiKey();
    const parsed = parseApiKey(k.plaintext)!;
    expect(parsed.prefix).toBe(k.prefix);
    expect(await verifySecret(parsed.secret, parsed.prefix, k.secretHash)).toBe(true);
  });

  it("el secreto NO se guarda en claro", async () => {
    const k = await mintApiKey();
    const secret = k.plaintext.split("_")[2]!;
    expect(k.secretHash).not.toContain(secret);
  });

  it("dos claves nunca coinciden", async () => {
    const a = await mintApiKey();
    const b = await mintApiKey();
    expect(a.prefix).not.toBe(b.prefix);
    expect(a.plaintext).not.toBe(b.plaintext);
  });

  it("rechaza un secreto equivocado aunque el prefijo sea correcto", async () => {
    const k = await mintApiKey();
    expect(await verifySecret("no-es-el-secreto", k.prefix, k.secretHash)).toBe(false);
  });

  it("el mismo secreto con otro prefijo no vale: el prefijo es la sal", async () => {
    const a = await mintApiKey();
    const secret = a.plaintext.split("_")[2]!;
    expect(await verifySecret(secret, "otro-prefijo", a.secretHash)).toBe(false);
  });

  it("acepta la cabecera con y sin Bearer", async () => {
    const k = await mintApiKey();
    expect(parseApiKey(`Bearer ${k.plaintext}`)?.prefix).toBe(k.prefix);
    expect(parseApiKey(k.plaintext)?.prefix).toBe(k.prefix);
  });

  it("el secreto puede contener guiones bajos sin romper el parseo", () => {
    // base64url incluye `_`. Partir la clave por ese carácter hacía fallar una
    // de cada pocas claves, de forma intermitente e irreproducible a mano.
    const parsed = parseApiKey("omni_a1b2c3d4e5f6_con_guiones_bajos-y-guiones")!;
    expect(parsed.prefix).toBe("a1b2c3d4e5f6");
    expect(parsed.secret).toBe("con_guiones_bajos-y-guiones");
  });

  it("doscientas claves seguidas se parsean todas", async () => {
    // El fallo anterior aparecía en una de cada pocas claves, según qué bytes
    // salieran del generador. Una sola comprobación no lo habría visto.
    // `verifySecret` se deja fuera del bucle a propósito: scrypt es lento por
    // diseño y aquí lo que se mide es el parseo, no el hash.
    const minted = await Promise.all(Array.from({ length: 200 }, () => mintApiKey()));
    for (const k of minted) {
      const parsed = parseApiKey(k.plaintext);
      expect(parsed, `no se pudo parsear ${k.plaintext}`).not.toBeNull();
      expect(parsed!.prefix).toBe(k.prefix);
      expect(`omni_${parsed!.prefix}_${parsed!.secret}`).toBe(k.plaintext);
    }
    expect(await verifySecret(parseApiKey(minted[0]!.plaintext)!.secret, minted[0]!.prefix, minted[0]!.secretHash)).toBe(true);
  }, 20000);

  it("rechaza formatos que no son nuestros", () => {
    expect(parseApiKey("")).toBeNull();
    expect(parseApiKey("Bearer abc")).toBeNull();
    expect(parseApiKey("otro_prefijo_secreto")).toBeNull();
    expect(parseApiKey("omni_solo-dos-partes")).toBeNull();
    expect(parseApiKey("omni_NOHEX_secreto")).toBeNull();
  });
});
