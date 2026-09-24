import { BufferJSON, initAuthCreds, proto } from "baileys";
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from "baileys";

/**
 * Estado de autenticación de Baileys respaldado por un BLOB.
 *
 * Baileys trae `useMultiFileAuthState`, que escribe decenas de ficheros en
 * disco. No sirve aquí: el disco de un contenedor desaparece en el siguiente
 * despliegue, y con él la sesión. Esta versión mantiene todo en memoria y lo
 * serializa a un único blob que el motor cifra y guarda en la base de datos.
 *
 * `BufferJSON` es obligatorio: las credenciales contienen `Buffer`s y claves
 * de curva que `JSON.stringify` a secas convierte en objetos inservibles. Una
 * sesión guardada mal no falla al guardarse, falla al reconectar.
 */

type KeyStore = Record<string, Record<string, unknown>>;

interface Serialized {
  readonly version: 1;
  readonly creds: unknown;
  readonly keys: KeyStore;
}

export class BlobAuthStore {
  #creds: AuthenticationCreds;
  #keys: KeyStore;
  readonly #onChange: () => void;

  private constructor(creds: AuthenticationCreds, keys: KeyStore, onChange: () => void) {
    this.#creds = creds;
    this.#keys = keys;
    this.#onChange = onChange;
  }

  /** Crea un estado nuevo o restaura uno guardado. */
  static from(blob: Uint8Array | null, onChange: () => void): BlobAuthStore {
    if (!blob || blob.byteLength === 0) {
      return new BlobAuthStore(initAuthCreds(), {}, onChange);
    }
    const parsed = JSON.parse(Buffer.from(blob).toString("utf8"), BufferJSON.reviver) as Serialized;
    if (parsed.version !== 1) {
      throw new Error(`formato de credenciales desconocido (versión ${String(parsed.version)})`);
    }
    return new BlobAuthStore(parsed.creds as AuthenticationCreds, parsed.keys ?? {}, onChange);
  }

  get creds(): AuthenticationCreds {
    return this.#creds;
  }

  serialize(): Uint8Array {
    const payload: Serialized = { version: 1, creds: this.#creds, keys: this.#keys };
    return new TextEncoder().encode(JSON.stringify(payload, BufferJSON.replacer));
  }

  /** El estado tal y como lo espera `makeWASocket`. */
  state(): AuthenticationState {
    return {
      creds: this.#creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const bucket = this.#keys[type] ?? {};
          const out: Record<string, SignalDataTypeMap[T]> = {};
          for (const id of ids) {
            let value = bucket[id];
            // Baileys espera este tipo ya deserializado; los demás van tal cual.
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            }
            if (value !== undefined) out[id] = value as SignalDataTypeMap[T];
          }
          return out;
        },
        set: async (data) => {
          for (const [type, values] of Object.entries(data)) {
            const bucket = (this.#keys[type] ??= {});
            for (const [id, value] of Object.entries(values as Record<string, unknown>)) {
              // `null` significa BORRAR la clave, no guardar un nulo: dejarlo
              // dentro corrompe el estado de sesión en la siguiente reconexión.
              if (value === null || value === undefined) delete bucket[id];
              else bucket[id] = value;
            }
          }
          this.#onChange();
        },
      },
    };
  }

  /** Se llama desde `creds.update`. */
  markCredsUpdated(creds?: AuthenticationCreds): void {
    if (creds) this.#creds = creds;
    this.#onChange();
  }
}
