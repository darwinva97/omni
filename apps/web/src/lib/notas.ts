import type { Mensaje, Nota } from "./api";
import { mismoDia } from "./formato";

/**
 * Las notas internas, metidas en el hilo por fecha.
 *
 * El hilo trae los últimos cien mensajes, o una ventana de hace meses tras
 * una búsqueda; las notas se piden aparte. Solo entran las que caen DENTRO de
 * lo que se ve: una nota de hace un año pegada encima de los mensajes de hoy
 * parecería escrita hoy.
 */
export type ElementoDelHilo =
  | {
      tipo: "mensaje"; m: Mensaje;
      /** El mensaje de antes, si va justo detrás de otro: una nota en medio abre tanda. */
      anterior: Mensaje | undefined;
      nuevoDia: boolean;
    }
  | { tipo: "nota"; n: Nota; nuevoDia: boolean };

export function intercalar(
  mensajes: readonly Mensaje[],
  notas: readonly Nota[],
  {
    desdeElPrincipio, hastaElFinal,
  }: {
    /** El hilo empieza en el primer mensaje del chat: valen las notas de antes. */
    desdeElPrincipio: boolean;
    /** El hilo llega hasta ahora (no es una ventana del pasado): valen las de después. */
    hastaElFinal: boolean;
  },
): ElementoDelHilo[] {
  const primero = mensajes[0]?.timestamp;
  const ultimo = mensajes.at(-1)?.timestamp;
  const dentro = notas.filter((n) =>
    (desdeElPrincipio || !primero || n.createdAt >= primero)
    && (hastaElFinal || !ultimo || n.createdAt <= ultimo));

  // Por fecha; a igualdad, el mensaje antes: la nota se escribe DESPUÉS de
  // leer lo que comenta.
  const todos = [
    ...mensajes.map((m) => ({ cuando: m.timestamp, orden: 0, m })),
    ...dentro.map((n) => ({ cuando: n.createdAt, orden: 1, n })),
  ].sort((a, b) => a.cuando.localeCompare(b.cuando) || a.orden - b.orden);

  const hilo: ElementoDelHilo[] = [];
  let previo: { cuando: string; m?: Mensaje } | undefined;
  for (const x of todos) {
    const nuevoDia = !previo || !mismoDia(previo.cuando, x.cuando);
    if ("m" in x && x.m) {
      hilo.push({ tipo: "mensaje", m: x.m, anterior: previo?.m, nuevoDia });
    } else if ("n" in x && x.n) {
      hilo.push({ tipo: "nota", n: x.n, nuevoDia });
    }
    previo = x;
  }
  return hilo;
}
