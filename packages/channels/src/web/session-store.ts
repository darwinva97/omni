import type { Storage } from "@omni/storage";

/**
 * Almacén de sesión para whatsapp-web.js.
 *
 * `RemoteAuth` comprime el perfil de Chromium entero y lo entrega como fichero:
 * decenas de megas, no kilobytes. Por eso este driver NO usa el blob de
 * credenciales del puerto —que va cifrado en una columna de la base— y guarda
 * el zip en el almacén de objetos.
 *
 * Es la diferencia práctica entre los dos transportes no oficiales: Baileys
 * guarda unas claves, esto guarda un navegador.
 */
export interface RemoteAuthStore {
  sessionExists(opts: { session: string }): Promise<boolean>;
  save(opts: { session: string }): Promise<void>;
  extract(opts: { session: string; path: string }): Promise<void>;
  delete(opts: { session: string }): Promise<void>;
}

export class ObjectStorageSessionStore implements RemoteAuthStore {
  readonly #storage: Storage;
  readonly #orgId: string;
  readonly #readFile: (p: string) => Promise<Uint8Array>;
  readonly #writeFile: (p: string, b: Uint8Array) => Promise<void>;

  constructor(
    storage: Storage,
    orgId: string,
    fs?: {
      readFile: (p: string) => Promise<Uint8Array>;
      writeFile: (p: string, b: Uint8Array) => Promise<void>;
    },
  ) {
    this.#storage = storage;
    this.#orgId = orgId;
    this.#readFile = fs?.readFile ?? (async (p) => (await import("node:fs/promises")).readFile(p));
    this.#writeFile = fs?.writeFile ?? (async (p, b) => (await import("node:fs/promises")).writeFile(p, b));
  }

  #clave(session: string): string {
    // El prefijo lleva la organización para que un solo prefijo delimite a un
    // inquilino, igual que con los medios.
    return `sessions/${this.#orgId}/wwebjs/${session}.zip`;
  }

  async sessionExists(opts: { session: string }): Promise<boolean> {
    return this.#storage.exists(this.#clave(opts.session));
  }

  /** `RemoteAuth` deja el zip en `./{session}.zip` y luego llama aquí. */
  async save(opts: { session: string }): Promise<void> {
    const local = `${opts.session}.zip`;
    const bytes = await this.#readFile(local);
    await this.#storage.put(this.#clave(opts.session), bytes, {
      mimeType: "application/zip",
      fileName: `${opts.session}.zip`,
    });
  }

  async extract(opts: { session: string; path: string }): Promise<void> {
    const guardado = await this.#storage.get(this.#clave(opts.session));
    if (!guardado) {
      // Que no haya sesión NO es un error: significa primer enlace, y
      // `RemoteAuth` sigue adelante pidiendo el QR.
      return;
    }
    await this.#writeFile(opts.path, guardado.bytes);
  }

  async delete(opts: { session: string }): Promise<void> {
    await this.#storage.delete(this.#clave(opts.session));
  }
}
