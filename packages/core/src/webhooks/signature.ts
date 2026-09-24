import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Firma de webhooks.
 *
 * Dos esquemas, como en crafter, pero con el orden de preferencia invertido:
 * aquí HMAC es el DEFECTO y el secreto en claro existe solo por compatibilidad
 * con clientes que esperan el esquema de WasenderAPI. Poner el secreto en una
 * cabecera lo expone en cada entrega y no prueba que el cuerpo no fuera alterado.
 */
export const SIGNATURE_HEADER = "x-omni-signature";
export const TIMESTAMP_HEADER = "x-omni-timestamp";

/** HMAC-SHA256 sobre el cuerpo CRUDO. Serializar de nuevo cambiaría el hash. */
export function signBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Firma con marca de tiempo: `t=<epoch>,v1=<hmac(t.body)>`. Sin la marca dentro
 * del hash, una entrega capturada puede reproducirse indefinidamente.
 */
export function signWithTimestamp(rawBody: string, secret: string, timestamp: number): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

const equal = (a: string, b: string): boolean => {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Comparar con `===` filtra información por el tiempo que tarda en fallar.
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

export interface VerifyOptions {
  /** Ventana de tolerancia para la marca de tiempo, en segundos. */
  readonly toleranceSeconds?: number;
  /** Aceptar el secreto en claro. Solo para compatibilidad. */
  readonly allowPlainSecret?: boolean;
  readonly now?: () => number;
}

export function verifySignature(
  rawBody: string,
  header: string,
  secret: string,
  opts: VerifyOptions = {},
): { ok: true } | { ok: false; reason: string } {
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = (opts.now ?? Date.now)();

  if (header.startsWith("t=")) {
    const parts = Object.fromEntries(
      header.split(",").map((p) => {
        const i = p.indexOf("=");
        return [p.slice(0, i), p.slice(i + 1)];
      }),
    );
    const t = Number(parts["t"]);
    const v1 = parts["v1"];
    if (!Number.isFinite(t) || typeof v1 !== "string") return { ok: false, reason: "cabecera malformada" };
    if (Math.abs(now / 1000 - t) > tolerance) return { ok: false, reason: "marca de tiempo fuera de ventana" };
    const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
    return equal(v1, expected) ? { ok: true } : { ok: false, reason: "firma no coincide" };
  }

  if (equal(header, signBody(rawBody, secret))) return { ok: true };
  if (opts.allowPlainSecret === true && equal(header, secret)) return { ok: true };
  return { ok: false, reason: "firma no coincide" };
}
