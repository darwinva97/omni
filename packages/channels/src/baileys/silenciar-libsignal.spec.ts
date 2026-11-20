import { describe, it, expect } from "vitest";
import { llevaClaves, sanear, silenciarSecretosDeLibsignal } from "./silenciar-libsignal.js";

/** Lo que imprime libsignal al cerrar una sesión: la sesión ENTERA. */
const sesion = () => ({
  registrationId: 123,
  currentRatchet: {
    ephemeralKeyPair: { pubKey: Buffer.alloc(33, 1), privKey: Buffer.alloc(32, 2) },
    rootKey: Buffer.alloc(32, 3),
  },
  indexInfo: { baseKey: Buffer.alloc(33, 4), closed: -1 },
});

function consolaFalsa() {
  const salida: unknown[][] = [];
  const c = {
    log: (...a: unknown[]) => salida.push(a), info: (...a: unknown[]) => salida.push(a),
    warn: (...a: unknown[]) => salida.push(a), error: (...a: unknown[]) => salida.push(a),
    debug: (...a: unknown[]) => salida.push(a),
  } as unknown as Console;
  return { c, salida };
}

describe("claves de libsignal fuera de los registros", () => {
  it("reconoce una sesión de Signal, aunque las claves vayan anidadas", () => {
    expect(llevaClaves(sesion())).toBe(true);
    expect(llevaClaves({ a: { b: { privKey: Buffer.alloc(1) } } })).toBe(true);
  });

  it("no confunde un objeto normal ni un Buffer suelto", () => {
    expect(llevaClaves({ lineId: "l1", err: "fallo" })).toBe(false);
    expect(llevaClaves(Buffer.alloc(32))).toBe(false);
    expect(llevaClaves(new Error("x"))).toBe(false);
  });

  it("aguanta referencias circulares", () => {
    const a: Record<string, unknown> = { n: 1 };
    a["yo"] = a;
    expect(llevaClaves(a)).toBe(false);
  });

  it("conserva el mensaje y quita la sesión", () => {
    const { c, salida } = consolaFalsa();
    silenciarSecretosDeLibsignal(c);

    c.info("Closing session:", sesion());

    expect(salida).toHaveLength(1);
    expect(salida[0]![0]).toBe("Closing session:");
    expect(String(salida[0]![1])).toContain("omitida");
    expect(JSON.stringify(salida)).not.toContain("privKey");
  });

  it("lo demás sale tal cual, y se instala una sola vez", () => {
    const { c, salida } = consolaFalsa();
    silenciarSecretosDeLibsignal(c);
    silenciarSecretosDeLibsignal(c);
    const datos = { lineId: "l1" };

    c.warn("aviso", datos);
    c.error("solo texto", 42);

    expect(salida).toEqual([["aviso", datos], ["solo texto", 42]]);
  });

  it("sanear no toca los argumentos sin claves", () => {
    const o = { x: 1 };
    expect(sanear(["a", o, 3])).toEqual(["a", o, 3]);
  });
});
