import type { RegistroBaileys } from "@omni/channels";

/**
 * Registro para Baileys, con nivel configurable.
 *
 * Baileys escribe mucho y por defecto en `info`. El diálogo con el servidor de
 * WhatsApp —qué nodo se manda, qué contesta, a qué dispositivos se cifra— solo
 * sale en `debug`, y hay fallos que no se pueden diagnosticar sin eso: un
 * mensaje que el servidor acepta y ningún cliente muestra no deja rastro en
 * `info`.
 *
 * Se escribe en JSON por línea, como el resto del registro del proceso.
 */
const ORDEN: Record<string, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
};

export function registroBaileys(nivel: string, ligaduras: Record<string, unknown> = {}): RegistroBaileys {
  const minimo = ORDEN[nivel] ?? 30;

  const escribir = (sev: string, args: unknown[]): void => {
    if ((ORDEN[sev] ?? 30) < minimo) return;
    // Baileys llama con `(objeto, mensaje)` o con `(mensaje)`; se admiten los dos.
    const [primero, segundo] = args;
    const datos = typeof primero === "object" && primero !== null ? primero : {};
    const msg = typeof primero === "string" ? primero : String(segundo ?? "");
    process.stdout.write(`${JSON.stringify({
      level: ORDEN[sev] ?? 30, time: new Date().toISOString(),
      class: "baileys", ...ligaduras, ...datos, msg,
    })}\n`);
  };

  return {
    level: nivel,
    trace: (...a) => escribir("trace", a),
    debug: (...a) => escribir("debug", a),
    info: (...a) => escribir("info", a),
    warn: (...a) => escribir("warn", a),
    error: (...a) => escribir("error", a),
    fatal: (...a) => escribir("fatal", a),
    child: (mas) => registroBaileys(nivel, { ...ligaduras, ...(mas as object) }),
  };
}
