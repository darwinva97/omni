import { inspect } from "node:util";

/**
 * Que `libsignal` no escriba claves privadas en los registros.
 *
 * La librería de cifrado de Baileys imprime con `console` cada sesión que abre
 * o cierra —«Closing session:», «Opening session:»…— y la sesión va ENTERA:
 * `privKey`, `rootKey`, las cadenas de claves. Esos registros acaban en
 * VictoriaLogs, y con ellos cualquiera que pueda leerlos tiene lo necesario
 * para descifrar las conversaciones de esa sesión.
 *
 * No hay opción para callarla, así que se cambia la salida: el mensaje se
 * conserva —sirve para ver que una sesión se renegoció— y cualquier argumento
 * que lleve material de claves se sustituye por una marca.
 */

/** Los campos que delatan una sesión de Signal o un par de claves. */
const CAMPOS_SECRETOS = new Set([
  "privKey", "rootKey", "chainKey", "messageKeys", "ephemeralKeyPair",
  "currentRatchet", "lastRemoteEphemeralKey",
]);

const MARCA = "[sesión de Signal omitida: lleva claves privadas]";

/** ¿Hay material de claves en `valor`, mirando solo unos niveles? */
export function llevaClaves(valor: unknown, profundidad = 0, vistos = new Set<object>()): boolean {
  if (!valor || typeof valor !== "object" || profundidad > 4) return false;
  if (vistos.has(valor)) return false;
  vistos.add(valor);
  if (Buffer.isBuffer(valor) || ArrayBuffer.isView(valor)) return false;
  let claves: string[];
  try {
    claves = Object.keys(valor);
  } catch {
    return false;
  }
  for (const k of claves) {
    if (CAMPOS_SECRETOS.has(k)) return true;
    let hijo: unknown;
    try {
      hijo = (valor as Record<string, unknown>)[k];
    } catch {
      continue;
    }
    if (llevaClaves(hijo, profundidad + 1, vistos)) return true;
  }
  return false;
}

/** Los argumentos tal cual, salvo los que lleven claves. */
export function sanear(args: readonly unknown[]): unknown[] {
  return args.map((a) => (llevaClaves(a) ? MARCA : a));
}

const INSTALADO = Symbol.for("omni.silenciarLibsignal");

/**
 * Envuelve `console.{log,info,warn,error,debug}` una sola vez por proceso.
 *
 * Solo se paga el recorrido en llamadas que lleven objetos: las de texto
 * —casi todas— salen tal cual.
 */
export function silenciarSecretosDeLibsignal(consola: Console = console): void {
  const marcada = consola as Console & { [INSTALADO]?: true };
  if (marcada[INSTALADO]) return;
  marcada[INSTALADO] = true;
  for (const nivel of ["log", "info", "warn", "error", "debug"] as const) {
    const original = consola[nivel].bind(consola);
    consola[nivel] = (...args: unknown[]) => {
      if (!args.some((a) => a !== null && typeof a === "object")) return original(...args);
      original(...sanear(args));
    };
  }
}

/** Para las pruebas: cómo se vería el argumento al imprimirse. */
export const verComoTexto = (args: readonly unknown[]): string =>
  sanear(args).map((a) => (typeof a === "string" ? a : inspect(a))).join(" ");
