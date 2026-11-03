import type { Llamada } from "./api";

/**
 * Lo que tarda WhatsApp en dar por perdida una llamada que nadie coge. Pasado
 * esto, una que siga «sonando» es que se perdió el aviso de cómo acabó: se
 * enseña perdida y se deja de ofrecer colgarla.
 */
const TIMBRE_MAXIMO_MS = 75_000;

/** Si sigue sonando de verdad, ahora. */
export function suena(l: Llamada, ahora = Date.now()): boolean {
  return l.state === "ringing" && ahora - l.startedAt < TIMBRE_MAXIMO_MS;
}

/** «Llamada de voz perdida», «Videollamada · 3:12». La misma regla que la API. */
export function textoDeLlamada(l: Llamada, ahora = Date.now()): string {
  const tipo = l.isVideo ? "Videollamada" : "Llamada de voz";
  if (l.state === "ringing") return suena(l, ahora) ? `${tipo} entrante` : `${tipo} perdida`;
  if (l.state === "missed") return `${tipo} perdida`;
  if (l.state === "rejected") return `${tipo} rechazada`;
  if (l.answeredAt && l.endedAt && l.endedAt > l.answeredAt) {
    const s = Math.round((l.endedAt - l.answeredAt) / 1000);
    return `${tipo} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  return tipo;
}

/** Perdida, para pintarla en rojo: es la que pide devolver la llamada. */
export function perdida(l: Llamada, ahora = Date.now()): boolean {
  return l.state === "missed" || (l.state === "ringing" && !suena(l, ahora));
}
