import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (p: string, s: string, l: number) => Promise<Buffer>;

/**
 * Claves de API.
 *
 * Formato `omni_<prefijo>_<secreto>`. El prefijo se guarda en claro para poder
 * localizar la fila sin comparar contra todas, y el secreto se guarda
 * HASHEADO: quien lea la base de datos no puede usar las claves. En el gateway
 * anterior el token estaba en claro y además se imprimía en los logs en cada
 * mensaje entrante.
 */
export interface MintedKey {
  readonly prefix: string;
  readonly secretHash: string;
  /** Se enseña UNA vez y no se puede volver a recuperar. */
  readonly plaintext: string;
}

const PREFIX_BYTES = 6;
const SECRET_BYTES = 24;

/**
 * El prefijo va en HEXADECIMAL a propósito. Con base64url podía contener `_`,
 * el mismo carácter que separa las tres partes de la clave, así que una de cada
 * pocas claves resultaba imposible de parsear: fallos de autenticación
 * esporádicos e imposibles de reproducir a mano.
 */
export async function mintApiKey(): Promise<MintedKey> {
  const prefix = randomBytes(PREFIX_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return {
    prefix,
    secretHash: await hashSecret(secret, prefix),
    plaintext: `omni_${prefix}_${secret}`,
  };
}

export async function hashSecret(secret: string, salt: string): Promise<string> {
  return (await scrypt(secret, salt, 32)).toString("base64");
}

export interface ParsedKey {
  readonly prefix: string;
  readonly secret: string;
}

/**
 * El secreto SÍ puede contener `_` (es base64url), así que no se parte por
 * separador: se reconoce el prefijo hexadecimal y el resto es el secreto entero.
 */
const KEY_RE = /^omni_([0-9a-f]{8,32})_(.+)$/;

/**
 * Saca el secreto de una clave completa.
 *
 * El secreto es base64url, que INCLUYE el guion bajo, y el guion bajo es
 * también el separador. Partir por él y coger el tercer trozo devuelve un
 * fragmento en el 41% de las claves. El analizador de arriba no cae porque su
 * último grupo es `(.+)$`, hasta el final; quien lo haga a mano, sí.
 */
export function secretoDe(plaintext: string): string | null {
  return parseApiKey(plaintext)?.secret ?? null;
}

export function parseApiKey(raw: string): ParsedKey | null {
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : raw.trim();
  const m = KEY_RE.exec(token);
  if (!m) return null;
  return { prefix: m[1]!, secret: m[2]! };
}

export async function verifySecret(secret: string, prefix: string, expectedHash: string): Promise<boolean> {
  const actual = Buffer.from(await hashSecret(secret, prefix), "base64");
  const expected = Buffer.from(expectedHash, "base64");
  // Comparación en tiempo constante: `===` filtra información por el tiempo.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
