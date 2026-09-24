import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verificación de la firma de un webhook.
 *
 * La firma va sobre el CUERPO CRUDO. Es el error número uno al integrar
 * webhooks firmados: cualquier middleware de JSON consume el flujo y deja sin
 * nada que hashear, así que hay que verificar antes de parsear.
 */
export const SIGNATURE_HEADER = "x-omni-signature";

export interface VerifyOptions {
  /** Tolerancia de la marca de tiempo, en segundos. */
  toleranceSeconds?: number;
  now?: () => number;
}

export function verifyWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  opts: VerifyOptions = {},
): { ok: true } | { ok: false; reason: string } {
  if (!signatureHeader) return { ok: false, reason: "falta la cabecera de firma" };

  const partes = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );
  const t = Number(partes["t"]);
  const v1 = partes["v1"];
  if (!Number.isFinite(t) || typeof v1 !== "string") {
    return { ok: false, reason: "cabecera de firma malformada" };
  }

  const ahora = (opts.now ?? Date.now)();
  const tolerancia = opts.toleranceSeconds ?? 300;
  // La marca va DENTRO del hash: sin comprobarla, una entrega capturada se
  // puede reproducir indefinidamente.
  if (Math.abs(ahora / 1000 - t) > tolerancia) {
    return { ok: false, reason: "marca de tiempo fuera de ventana" };
  }

  const esperado = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  const a = Buffer.from(v1, "utf8");
  const b = Buffer.from(esperado, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "la firma no coincide" };
  }
  return { ok: true };
}

export interface WebhookEvent<T = unknown> {
  readonly event: string;
  readonly lineId: string;
  readonly orgId: string;
  readonly timestamp: number;
  readonly data: T;
}

/** Verifica y parsea en un paso. Lanza si la firma no vale. */
export function parseWebhook<T = unknown>(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  opts?: VerifyOptions,
): WebhookEvent<T> {
  const res = verifyWebhook(rawBody, signatureHeader, secret, opts);
  if (!res.ok) throw new Error(`webhook rechazado: ${res.reason}`);
  return JSON.parse(rawBody) as WebhookEvent<T>;
}
