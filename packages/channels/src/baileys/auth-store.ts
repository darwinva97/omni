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

/** Una clave de la sesión, serializada (BufferJSON) para guardarla en su fila; `null` = borrarla. */
export interface CambioDeClave {
  readonly type: string;
  readonly id: string;
  readonly value: Uint8Array | null;
}

export class BlobAuthStore {
  #creds: AuthenticationCreds;
  #keys: KeyStore;
  readonly #onChange: () => void;
  /** Claves cambiadas desde el último guardado por filas (`tipo\0id`), y si cambiaron las credenciales. */
  #sucias = new Set<string>();
  #credsSucias = false;

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
              this.#sucias.add(`${type}\0${id}`);
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
    this.#credsSucias = true;
    this.#onChange();
  }

  /* ── Guardado por filas: las credenciales en un blob y cada clave en la suya. ── */

  /** ¿Traía el blob guardado claves dentro? (formato antiguo: se pasan a filas una vez). */
  get clavesEnBlob(): boolean {
    return Object.values(this.#keys).some((b) => Object.keys(b).length > 0);
  }

  /** Las claves guardadas en filas, encima de lo que traía el blob (mandan las filas). */
  mezclar(filas: ReadonlyArray<{ type: string; id: string; value: Uint8Array }>): void {
    for (const f of filas) {
      const valor = JSON.parse(Buffer.from(f.value).toString("utf8"), BufferJSON.reviver) as unknown;
      (this.#keys[f.type] ??= {})[f.id] = valor;
    }
  }

  /** Marca todo para guardar (al pasar del formato antiguo a filas). */
  marcarTodo(): void {
    for (const [type, b] of Object.entries(this.#keys)) for (const id of Object.keys(b)) this.#sucias.add(`${type}\0${id}`);
    this.#credsSucias = true;
  }

  /** Lo que cambió desde la última vez, y lo deja como guardado. */
  tomarCambios(): { claves: CambioDeClave[]; creds: Uint8Array | null } {
    const claves: CambioDeClave[] = [];
    for (const k of this.#sucias) {
      const [type, id] = k.split("\0") as [string, string];
      const v = this.#keys[type]?.[id];
      claves.push({
        type,
        id,
        value: v === undefined ? null : new TextEncoder().encode(JSON.stringify(v, BufferJSON.replacer)),
      });
    }
    this.#sucias.clear();
    const creds = this.#credsSucias ? this.serializarCreds() : null;
    this.#credsSucias = false;
    return { claves, creds };
  }

  /** Si guardar falló, lo tomado vuelve a quedar pendiente (se guarda en la vuelta siguiente). */
  devolver(claves: ReadonlyArray<CambioDeClave>, creds: boolean): void {
    for (const c of claves) this.#sucias.add(`${c.type}\0${c.id}`);
    if (creds) this.#credsSucias = true;
  }

  /** El blob sólo con las credenciales (las claves van en filas). */
  serializarCreds(): Uint8Array {
    const payload: Serialized = { version: 1, creds: this.#creds, keys: {} };
    return new TextEncoder().encode(JSON.stringify(payload, BufferJSON.replacer));
  }
}
