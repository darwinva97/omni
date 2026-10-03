import { OmniError } from "@omni/shared";
import type { Kv } from "@omni/platform";

/**
 * Freno de intentos para el inicio de sesión.
 *
 * Sin esto, una contraseña expuesta a internet se puede adivinar a ritmo de
 * red: no hay nada que distinga el intento número uno del número cien mil. El
 * retardo artificial del verificador no basta —se paraleliza— así que hace
 * falta contar.
 *
 * Se cuenta por DOS ejes a la vez y se bloquea si cualquiera se pasa:
 *
 * - Por **cuenta**, para que no se pueda martillear un correo concreto desde
 *   mil direcciones distintas.
 * - Por **origen**, para que una sola dirección no pueda recorrer una lista de
 *   correos probando la misma contraseña en todos (eso es lo que hace un
 *   ataque de relleno de credenciales, y el contador por cuenta no lo ve).
 *
 * Vive en el KV, que está respaldado por Postgres: así el freno es del
 * servicio entero y no de un proceso, y repartir la API entre varios nodos no
 * multiplica los intentos permitidos por el número de nodos.
 */

/** Intentos fallidos permitidos antes de bloquear, por ventana. */
export const MAX_POR_CUENTA = 8;
export const MAX_POR_ORIGEN = 30;
/** Ventana en segundos. Al expirar la clave, el contador se olvida solo. */
export const VENTANA_SEGUNDOS = 900;

export interface FrenoDeps {
  readonly kv: Kv;
}

const clave = (eje: string, valor: string): string =>
  `login:fallos:${eje}:${valor.toLowerCase().slice(0, 120)}`;

/**
 * Comprueba antes de verificar la contraseña. Lanza 429 si toca esperar.
 *
 * Se mira ANTES de gastar tiempo en el hash: si no, el bloqueo seguiría
 * costando lo mismo que un intento legítimo y serviría de poco contra alguien
 * que solo quiere consumir CPU.
 */
export async function exigirIntentoPermitido(
  deps: FrenoDeps, email: string, origen: string | null,
): Promise<void> {
  const cuenta = Number((await deps.kv.get(clave("cuenta", email))) ?? 0);
  if (cuenta >= MAX_POR_CUENTA) {
    throw new OmniError(
      "rate_limited",
      "demasiados intentos con esa cuenta; espera unos minutos",
      { retryAfterSeconds: VENTANA_SEGUNDOS },
    );
  }
  if (origen) {
    const porOrigen = Number((await deps.kv.get(clave("origen", origen))) ?? 0);
    if (porOrigen >= MAX_POR_ORIGEN) {
      throw new OmniError(
        "rate_limited",
        "demasiados intentos desde este origen; espera unos minutos",
        { retryAfterSeconds: VENTANA_SEGUNDOS },
      );
    }
  }
}

/** Apunta un fallo. La ventana se cuenta desde el primer fallo, no desde el último. */
export async function anotarFallo(
  deps: FrenoDeps, email: string, origen: string | null,
): Promise<void> {
  await deps.kv.increment(clave("cuenta", email), 1, VENTANA_SEGUNDOS);
  if (origen) await deps.kv.increment(clave("origen", origen), 1, VENTANA_SEGUNDOS);
}

/**
 * Olvida los fallos de una cuenta tras un acierto.
 *
 * Solo el eje de la cuenta: el del origen se mantiene a propósito, porque si
 * se borrara, quien tenga UNA credencial válida podría usarla para resetear el
 * contador entre tanda y tanda de adivinanzas.
 */
export async function olvidarFallos(deps: FrenoDeps, email: string): Promise<void> {
  await deps.kv.delete(clave("cuenta", email));
}

/**
 * De dónde viene la petición.
 *
 * Detrás de Caddy la dirección del zócalo es siempre `127.0.0.1`, así que se
 * lee la cabecera que pone el proxy. Es falsificable por quien pueda hablar
 * DIRECTAMENTE con el servicio, y por eso el freno por cuenta —que no depende
 * de ella— es el que de verdad protege; el de origen es una capa de más contra
 * el relleno de credenciales.
 */
export function origenDe(cabeceras: { get(n: string): string | undefined }): string | null {
  const reenviado = cabeceras.get("x-forwarded-for");
  if (reenviado) {
    const primero = reenviado.split(",")[0]?.trim();
    if (primero) return primero;
  }
  return cabeceras.get("x-real-ip") ?? null;
}
