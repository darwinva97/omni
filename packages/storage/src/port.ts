import { z } from "zod";

/**
 * Almacén de objetos.
 *
 * Los binarios NUNCA van a la base de datos: ahí solo vive la clave y los
 * metadatos. Lo que se guarda es privado y se lee por URL firmada con
 * caducidad, no por una ruta pública adivinable. En el gateway anterior los
 * adjuntos se escribían bajo `public/` y los servía el framework sin pasar por
 * ninguna comprobación: quien tuviera la URL leía los adjuntos de cualquier
 * inquilino.
 */

export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly mimeType: string;
  readonly checksum: string;
}

export interface PutOptions {
  readonly mimeType: string;
  readonly fileName?: string;
  /** Sugerencia de caducidad. El barrido de retención la respeta. */
  readonly retainUntil?: Date;
}

export interface Storage {
  readonly kind: "local" | "s3";
  put(key: string, bytes: Uint8Array, opts: PutOptions): Promise<StoredObject>;
  get(key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** URL temporal de lectura. Nunca se expone una ruta permanente. */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
}

export const MAX_OBJECT_BYTES = 100 * 1024 * 1024;

/**
 * Construye la clave de un objeto. El orden importa: empezar por la
 * organización y la línea hace que un prefijo delimite exactamente a un
 * inquilino, lo que permite borrar o migrar uno entero sin tocar a los demás.
 */
export function mediaKey(parts: {
  orgId: string; lineId: string; messageId: string; fileName?: string;
}): string {
  // Se colapsan las secuencias de puntos además de los caracteres raros: la
  // comprobación de ruta del almacén local ya impide salirse del directorio,
  // pero una clave que ni siquiera contiene ".." no depende de ella.
  const safe = (v: string): string =>
    v.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, "_").slice(0, 120);
  const rawExt = parts.fileName?.includes(".") ? parts.fileName.split(".").pop()!.toLowerCase() : "";
  const ext = rawExt ? `.${safe(rawExt)}` : "";
  return `media/${safe(parts.orgId)}/${safe(parts.lineId)}/${safe(parts.messageId)}${ext}`;
}

export const StorageConfig = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    /** Directorio base. Debe quedar FUERA de cualquier carpeta servida estáticamente. */
    directory: z.string().min(1),
    /** Base para las URLs firmadas que sirve la API. */
    publicBase: z.string().default("/v1/media"),
    signingSecret: z.string().min(16),
  }),
  z.object({
    kind: z.literal("s3"),
    bucket: z.string().min(1),
    region: z.string().default("auto"),
    endpoint: z.string().optional(),
    /** Host contra el que se firman las URLs de descarga, si no es `endpoint`. */
    publicEndpoint: z.string().optional(),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    forcePathStyle: z.boolean().default(true),
  }),
]);
export type StorageConfig = z.infer<typeof StorageConfig>;
