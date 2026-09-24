import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { OmniError } from "@omni/shared";
import { MAX_OBJECT_BYTES, type PutOptions, type Storage, type StoredObject } from "./port.js";

/**
 * Almacén en disco.
 *
 * Los ficheros van a un directorio propio, **fuera** de cualquier carpeta que
 * el servidor publique estáticamente, y se leen por una URL firmada que caduca.
 */
export class LocalStorage implements Storage {
  readonly kind = "local" as const;
  readonly #root: string;
  readonly #base: string;
  readonly #secret: string;
  readonly #now: () => number;

  constructor(
    opts: { directory: string; publicBase?: string; signingSecret: string },
    deps: { now?: () => number } = {},
  ) {
    this.#root = resolve(opts.directory);
    this.#base = opts.publicBase ?? "/v1/media";
    this.#secret = opts.signingSecret;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Resuelve una clave a una ruta dentro del directorio raíz.
   *
   * Una clave con `../` podría salirse y leer o pisar cualquier fichero del
   * sistema. Se comprueba que la ruta resuelta siga estando dentro.
   */
  #pathFor(key: string): string {
    const full = resolve(join(this.#root, normalize(key)));
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
      throw new OmniError("validation_failed", `la clave "${key}" se sale del almacén`);
    }
    return full;
  }

  async put(key: string, bytes: Uint8Array, opts: PutOptions): Promise<StoredObject> {
    if (bytes.byteLength > MAX_OBJECT_BYTES) {
      throw new OmniError("validation_failed", `el objeto supera el máximo de ${MAX_OBJECT_BYTES} bytes`, {
        size: bytes.byteLength, max: MAX_OBJECT_BYTES,
      });
    }
    const path = this.#pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await writeFile(`${path}.meta`, JSON.stringify({ mimeType: opts.mimeType, fileName: opts.fileName }));
    return {
      key,
      size: bytes.byteLength,
      mimeType: opts.mimeType,
      checksum: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async get(key: string): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    const path = this.#pathFor(key);
    try {
      const bytes = await readFile(path);
      let mimeType = "application/octet-stream";
      try {
        mimeType = (JSON.parse(await readFile(`${path}.meta`, "utf8")) as { mimeType?: string }).mimeType ?? mimeType;
      } catch { /* sin metadatos: tipo genérico */ }
      return { bytes, mimeType };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.#pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.meta`, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.#pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    const expires = Math.floor(this.#now() / 1000) + ttlSeconds;
    const sig = this.#sign(key, expires);
    return `${this.#base}/${encodeURIComponent(key)}?expires=${expires}&signature=${sig}`;
  }

  #sign(key: string, expires: number): string {
    return createHmac("sha256", this.#secret).update(`${key}:${expires}`).digest("hex");
  }

  /** Valida una firma. La usa la ruta que sirve los medios locales. */
  verify(key: string, expires: number, signature: string): { ok: true } | { ok: false; reason: string } {
    if (!Number.isFinite(expires)) return { ok: false, reason: "caducidad inválida" };
    if (expires * 1000 <= this.#now()) return { ok: false, reason: "el enlace ha caducado" };
    const expected = Buffer.from(this.#sign(key, expires), "utf8");
    const given = Buffer.from(signature, "utf8");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return { ok: false, reason: "firma no válida" };
    }
    return { ok: true };
  }
}
