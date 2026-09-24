import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, l: number) => Promise<Buffer>;

/**
 * Contraseñas con scrypt.
 *
 * scrypt es deliberadamente lento y costoso en memoria: un atacante con la
 * base de datos robada no puede probar millones de candidatas por segundo. Los
 * parámetros van DENTRO del hash para poder subirlos con el tiempo sin
 * invalidar las contraseñas ya guardadas.
 */

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const VERSION = "s1";

export const MIN_PASSWORD_LENGTH = 12;

export class PasswordError extends Error {}

/** Devuelve `s1$<salt>$<hash>`, ambos en base64url. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordError(`la contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_BYTES);
  return `${VERSION}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const partes = stored.split("$");
  if (partes.length !== 3 || partes[0] !== VERSION) return false;
  try {
    const salt = Buffer.from(partes[1]!, "base64url");
    const esperado = Buffer.from(partes[2]!, "base64url");
    const actual = await scrypt(password, salt, esperado.length);
    return actual.length === esperado.length && timingSafeEqual(actual, esperado);
  } catch {
    return false;
  }
}

/**
 * Gasta el mismo tiempo que una verificación real.
 *
 * Sin esto, un correo que no existe responde mucho más rápido que uno que sí,
 * y eso permite enumerar quién tiene cuenta.
 */
export async function fakeVerify(): Promise<void> {
  await scrypt("contraseña-que-no-existe", randomBytes(SALT_BYTES), KEY_BYTES);
}

/** Token opaco para sesiones e invitaciones. Se guarda hasheado. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function hashToken(token: string): Promise<string> {
  // Sin sal: el token ya es aleatorio de 256 bits, así que no hay diccionario
  // que valga y así se puede buscar por hash con un índice.
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(token).digest("base64url");
}
