import { OmniError, type SendMessageInput } from "@omni/shared";
import { MAX_OBJECT_BYTES, mediaKey, type Storage } from "./port.js";

/**
 * Resolución de medios.
 *
 * Un envío puede traer el contenido de tres formas: una URL remota, una clave
 * ya subida a nuestro almacén, o bytes en base64. Aquí se convierten todas a lo
 * mismo —bytes más tipo— y se guardan antes de encolar, para que el momento del
 * envío no dependa de que un servidor ajeno siga en pie.
 */

export interface ResolvedMedia {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly fileName?: string;
  readonly storageKey: string;
  readonly size: number;
  readonly checksum: string;
}

export interface MediaResolverDeps {
  readonly storage: Storage;
  readonly fetchImpl?: typeof fetch;
  /** Tiempo máximo para descargar una URL ajena. */
  readonly downloadTimeoutMs?: number;
}

/** Los campos de envío que llevan un medio, y el tipo de mensaje que producen. */
const MEDIA_FIELDS = ["image", "video", "audio", "document", "sticker"] as const;
export type MediaField = (typeof MEDIA_FIELDS)[number];

export const mediaFieldOf = (input: SendMessageInput): MediaField | null =>
  MEDIA_FIELDS.find((f) => input[f] !== undefined) ?? null;

/**
 * Sólo se descargan URLs http(s) hacia direcciones que no sean internas.
 *
 * Sin esta comprobación, un cliente puede hacer que el servidor pida
 * `http://169.254.169.254/` o `http://127.0.0.1:5432` y usarlo de puente hacia
 * la red interna: el clásico SSRF, y aquí sería con nuestras credenciales.
 */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OmniError("validation_failed", `"${raw}" no es una URL válida`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OmniError("validation_failed", `esquema no permitido: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  const prohibido =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]";
  if (prohibido) {
    throw new OmniError("validation_failed", `no se descargan URLs hacia direcciones internas: ${host}`, { host });
  }
  return url;
}

export async function resolveMedia(
  input: SendMessageInput,
  ctx: { orgId: string; lineId: string; messageId: string },
  deps: MediaResolverDeps,
): Promise<ResolvedMedia | null> {
  const field = mediaFieldOf(input);
  if (!field) return null;
  const source = input[field]!;
  const doFetch = deps.fetchImpl ?? fetch;

  let bytes: Uint8Array;
  let mimeType: string;

  if ("storageKey" in source) {
    const found = await deps.storage.get(source.storageKey);
    if (!found) throw new OmniError("not_found", `no hay ningún objeto con la clave "${source.storageKey}"`);
    // Ya está guardado: no se copia ni se vuelve a subir.
    return {
      bytes: found.bytes, mimeType: found.mimeType,
      ...(input.fileName ? { fileName: input.fileName } : {}),
      storageKey: source.storageKey, size: found.bytes.byteLength,
      checksum: "",
    };
  }

  if ("base64" in source) {
    bytes = Buffer.from(source.base64, "base64");
    mimeType = source.mimeType;
    if (bytes.byteLength === 0) {
      throw new OmniError("validation_failed", "el contenido en base64 está vacío o mal codificado");
    }
  } else {
    const url = assertFetchableUrl(source.url);
    const res = await doFetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(deps.downloadTimeoutMs ?? 15000),
    }).catch((err: unknown) => {
      throw new OmniError("upstream_failed", `no se pudo descargar el medio: ${(err as Error).message}`);
    });
    if (!res.ok) {
      throw new OmniError("upstream_failed", `el origen del medio respondió ${res.status}`, { status: res.status });
    }
    // Se comprueba el tamaño ANTES de volcarlo entero en memoria cuando el
    // origen declara su longitud.
    const declarado = Number(res.headers.get("content-length") ?? 0);
    if (declarado > MAX_OBJECT_BYTES) {
      throw new OmniError("validation_failed", "el medio supera el tamaño máximo", { size: declarado });
    }
    bytes = new Uint8Array(await res.arrayBuffer());
    mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  }

  const key = mediaKey({ ...ctx, ...(input.fileName ? { fileName: input.fileName } : {}) });
  const stored = await deps.storage.put(key, bytes, {
    mimeType,
    ...(input.fileName ? { fileName: input.fileName } : {}),
  });

  return {
    bytes, mimeType,
    ...(input.fileName ? { fileName: input.fileName } : {}),
    storageKey: stored.key, size: stored.size, checksum: stored.checksum,
  };
}
