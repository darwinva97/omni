import { describe, it, expect } from "vitest";
import { signBody, signWithTimestamp, verifySignature } from "./signature.js";

const SECRET = "s3cr3t-de-pruebas";
const BODY = JSON.stringify({ event: "message.received", data: { text: "hola" } });

describe("firma de webhooks", () => {
  it("verifica una firma HMAC simple", () => {
    expect(verifySignature(BODY, signBody(BODY, SECRET), SECRET)).toEqual({ ok: true });
  });

  it("rechaza un cuerpo alterado", () => {
    const sig = signBody(BODY, SECRET);
    const res = verifySignature(BODY.replace("hola", "adiós"), sig, SECRET);
    expect(res.ok).toBe(false);
  });

  it("rechaza otro secreto", () => {
    expect(verifySignature(BODY, signBody(BODY, "otro"), SECRET).ok).toBe(false);
  });

  it("acepta la firma con marca de tiempo dentro de la ventana", () => {
    const now = 1_800_000_000_000;
    const sig = signWithTimestamp(BODY, SECRET, Math.floor(now / 1000));
    expect(verifySignature(BODY, sig, SECRET, { now: () => now })).toEqual({ ok: true });
  });

  it("rechaza una entrega reproducida fuera de la ventana", () => {
    // Sin esto, capturar una entrega válida permite repetirla para siempre.
    const then = 1_800_000_000_000;
    const sig = signWithTimestamp(BODY, SECRET, Math.floor(then / 1000));
    const res = verifySignature(BODY, sig, SECRET, { now: () => then + 10 * 60 * 1000 });
    expect(res).toEqual({ ok: false, reason: "marca de tiempo fuera de ventana" });
  });

  it("el secreto en claro solo vale si se pide explícitamente", () => {
    expect(verifySignature(BODY, SECRET, SECRET).ok).toBe(false);
    expect(verifySignature(BODY, SECRET, SECRET, { allowPlainSecret: true }).ok).toBe(true);
  });

  it("una cabecera malformada no cuela", () => {
    expect(verifySignature(BODY, "t=abc,v1=", SECRET).ok).toBe(false);
    expect(verifySignature(BODY, "", SECRET).ok).toBe(false);
  });
});
