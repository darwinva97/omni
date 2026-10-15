import type { Mensaje } from "./api";

/**
 * Dónde empieza cada tanda del hilo.
 *
 * Una tanda es una ráfaga de la MISMA persona: abre con su nombre, su foto y la
 * cola de la burbuja, y las siguientes van pegadas y sin nada de eso.
 *
 * Antes solo se miraba si el mensaje era propio o ajeno. En un chat de dos eso
 * basta; en un grupo, «ajeno» son muchas personas, y lo que escribían aimet y
 * Esteban salía debajo del nombre de Rodrigo, sin el suyo.
 */

type DeTanda = Pick<Mensaje, "fromMe" | "senderAddress" | "kind" | "body" | "deleted">;

/** Si dos mensajes seguidos son de la misma persona. */
export function mismoRemitente(a: DeTanda, b: DeTanda, esGrupo: boolean): boolean {
  if (a.fromMe !== b.fromMe) return false;
  if (a.fromMe || !esGrupo) return true;
  return (a.senderAddress ?? null) === (b.senderAddress ?? null);
}

/** Lo que este transporte no supo leer: va centrado, fuera de toda tanda. */
export function esAvisoDe(m: DeTanda): boolean {
  if (m.kind === "notice") return true;
  return (m.kind === "system" || m.kind === "unknown") && !m.body && !m.deleted;
}

/** Si un mensaje abre tanda, dado el anterior. El cambio de día lo decide quien llama. */
export function abreTanda(anterior: DeTanda | undefined, m: DeTanda, esGrupo: boolean): boolean {
  return !anterior || !mismoRemitente(anterior, m, esGrupo) || esAvisoDe(anterior);
}
