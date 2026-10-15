/**
 * Qué líneas están caídas, y cómo se sabe en vivo.
 *
 * La API deja el último estado de cada línea en `GET /v1/lines` y avisa de
 * cada cambio por el socket con los eventos `session.*`. Aquí se juntan las
 * dos cosas, sin React, para poder probarlas.
 */

export type Caida = "desconectada" | "sin-sesion";

export interface LineaVigilada {
  id: string;
  name: string;
  status: string;
  /** Su número. Solo lo tiene una línea que llegó a enlazarse alguna vez. */
  address: string | null;
  enabled: boolean;
}

/** El estado de una línea tras un evento `session.*`. `null`: el evento no lo cambia. */
export function estadoTrasEvento(evento: string, data: Record<string, unknown>): string | null {
  switch (evento) {
    case "session.connected": return "connected";
    case "session.disconnected": return "disconnected";
    case "session.logged_out": return "logged-out";
    case "session.status": return typeof data["state"] === "string" ? data["state"] : null;
    default: return null;
  }
}

/**
 * Si hay que avisar de esta línea, y de qué.
 *
 * Solo de las que funcionaban: una línea recién creada, que nunca se enlazó,
 * está «desconectada» desde el primer día y no ha dejado de hacer nada. Su
 * sitio para enlazarla es su propia pantalla, no una franja en todas.
 *
 * Esperando QR cuenta como sin sesión si ya estuvo enlazada: es lo que pasa
 * cuando WhatsApp la desvincula y alguien pulsa «conectar» para volver.
 */
export function caidaDe(l: LineaVigilada): Caida | null {
  if (!l.enabled || !l.address) return null;
  if (l.status === "logged-out" || l.status === "awaiting-link") return "sin-sesion";
  if (l.status === "disconnected") return "desconectada";
  return null;
}

/** Lo que se dice de una línea caída, en la franja y en el aviso del navegador. */
export function textoDeCaida(nombre: string, c: Caida): { titulo: string; detalle: string } {
  return c === "sin-sesion"
    ? {
        titulo: `La línea ${nombre} ha perdido la sesión`,
        detalle: "WhatsApp la desvinculó: hay que volver a escanear el QR.",
      }
    : {
        titulo: `La línea ${nombre} se ha desconectado`,
        detalle: "No recibe ni envía mensajes hasta que se reconecte.",
      };
}
