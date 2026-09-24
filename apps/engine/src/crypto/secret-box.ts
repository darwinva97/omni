import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Caja sellada para las credenciales de las líneas.
 *
 * Las credenciales de un driver son equivalentes a la sesión del teléfono:
 * quien las tiene, es la cuenta. Van cifradas en la base de datos y NO en el
 * sistema de ficheros, para que un redespliegue reconecte en vez de pedir otro
 * escaneo del QR —y para que una copia de seguridad de la BD no las regale.
 *
 * AES-256-GCM: cifra y además autentica, así que una caja manipulada falla al
 * abrirse en vez de devolver basura.
 */

const ALGO = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SALT = Buffer.from("omni.secret-box.v1");

export class SecretBoxError extends Error {}

/** Deriva la clave de 32 bytes. Acepta tanto 64 hex como una frase larga. */
export function deriveKey(master: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(master)) return Buffer.from(master, "hex");
  if (master.length < 32) {
    throw new SecretBoxError(
      "la clave maestra debe ser 64 caracteres hex o una frase de al menos 32; " +
        "perderla significa perder TODAS las sesiones",
    );
  }
  return scryptSync(master, SALT, 32);
}

export class SecretBox {
  readonly #key: Buffer;
  readonly version: number;

  constructor(master: string, version = 1) {
    this.#key = deriveKey(master);
    this.version = version;
  }

  /** Devuelve `v1.<nonce>.<tag>.<ciphertext>` en base64url. */
  seal(plain: Uint8Array): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGO, this.#key, nonce);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      `v${this.version}`,
      nonce.toString("base64url"),
      tag.toString("base64url"),
      body.toString("base64url"),
    ].join(".");
  }

  open(sealed: string): Uint8Array {
    const parts = sealed.split(".");
    if (parts.length !== 4 || !parts[0]!.startsWith("v")) {
      throw new SecretBoxError("caja sellada con formato desconocido");
    }
    const nonce = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const body = Buffer.from(parts[3]!, "base64url");
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretBoxError("nonce o etiqueta de autenticación con tamaño inválido");
    }
    const decipher = createDecipheriv(ALGO, this.#key, nonce);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      // GCM falla aquí si la caja fue manipulada o la clave no es la correcta.
      throw new SecretBoxError("no se pudo abrir la caja: clave incorrecta o contenido manipulado");
    }
  }

  /** Comprueba que una clave maestra abre una caja, sin revelar el contenido. */
  canOpen(sealed: string): boolean {
    try {
      this.open(sealed);
      return true;
    } catch {
      return false;
    }
  }
}

/** Compara dos secretos en tiempo constante. */
export function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
