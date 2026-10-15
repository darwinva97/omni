import type { Chat, Conversacion, EstadoDeConversacion, Miembro } from "./api";

/**
 * Quién lleva cada chat y en qué estado está, visto desde el panel.
 *
 * Vive aparte de la lista y de la conversación porque las dos dicen lo mismo
 * —el nombre del estado, quién lo lleva, qué chats son «míos»— y dos copias
 * acaban diciendo «Pendiente» en una y «En espera» en la otra.
 */

/** Cómo se llama cada estado, y qué significa para quien atiende. */
export const ESTADOS: Record<EstadoDeConversacion, { texto: string; explica: string }> = {
  open: { texto: "Abierta", explica: "hay que atenderla" },
  // Pendiente y pospuesta vuelven solas a abierta cuando el cliente escribe:
  // las dos sacan el chat de en medio sin perderlo.
  pending: { texto: "Pendiente", explica: "esperando al cliente" },
  snoozed: { texto: "Pospuesta", explica: "hasta que vuelva a escribir" },
  resolved: { texto: "Resuelta", explica: "ya está atendida" },
};

/** Los filtros de atención, que van entre las pestañas de la lista. */
export type FiltroDeAtencion = "mios" | "sin-asignar" | "resueltos";

const viva = (c: Conversacion | null | undefined): c is Conversacion =>
  Boolean(c) && c!.status !== "resolved";

/**
 * Si un chat entra en un filtro.
 *
 * «Míos» y «Sin asignar» miran solo lo que está VIVO: una conversación
 * resuelta ya no es trabajo de nadie, y verla en «Míos» haría creer que queda
 * algo por hacer. Un chat que nunca ha tenido conversación no está «sin
 * asignar»: nadie ha pedido nada todavía.
 */
export function enFiltro(chat: Chat, filtro: FiltroDeAtencion, yo: string | null): boolean {
  const c = chat.conversation;
  switch (filtro) {
    case "mios": return viva(c) && yo !== null && c.assigneeId === yo;
    case "sin-asignar": return viva(c) && c.assigneeId === null;
    case "resueltos": return c?.status === "resolved";
  }
}

/** El nombre de quien lleva un chat. «Tú» si eres tú: es lo que se lee antes. */
export function nombreDeResponsable(
  id: string | null | undefined, miembros: readonly Miembro[], yo: string | null,
): string | null {
  if (!id) return null;
  if (id === yo) return "Tú";
  return miembros.find((m) => m.userId === id)?.name ?? "Alguien del equipo";
}

/**
 * Aplica a la lista el cambio que llega por el socket.
 *
 * Solo pisa la que el chat ya tenía si es la MISMA o una más nueva. La
 * resuelta de ayer no puede tapar la que el cliente acaba de abrir hoy,
 * aunque su aviso llegue después por el orden en que viajan los eventos.
 */
export function conConversacion(chats: readonly Chat[], conv: Conversacion): Chat[] {
  return chats.map((x) => {
    if (x.address !== conv.chatId) return x;
    const actual = x.conversation;
    if (actual && actual.id !== conv.id) {
      if (viva(actual) && !viva(conv)) return x;
      if (actual.openedAt > conv.openedAt) return x;
    }
    return { ...x, conversation: conv };
  });
}

/** Lo que se le puede pedir a la conversación de un chat desde el panel. */
export interface CambioDeAtencion {
  status?: EstadoDeConversacion;
  assigneeId?: string | null;
}

/**
 * Cambia quién lleva un chat o su estado.
 *
 * Si el chat no tiene conversación viva —nunca la tuvo, o se resolvió y se
 * quiere reabrir—, se abre una con el cambio puesto: «Asignarme» un chat
 * antiguo tiene que funcionar igual que en uno que acaba de escribir.
 *
 * Devuelve la conversación como queda o el motivo del fallo, para
 * enseñarlo: un clic que no hace nada y no dice por qué es lo peor.
 */
export async function cambiarAtencion(
  lineId: string, chat: string, actual: Conversacion | null | undefined, cambio: CambioDeAtencion,
): Promise<{ conv: Conversacion } | { error: string }> {
  const reabrir = actual?.status === "resolved"
    && cambio.status !== undefined && cambio.status !== "resolved";
  const sobreLaActual = actual && (actual.status !== "resolved" || reabrir || !cambio.assigneeId);
  const r = sobreLaActual
    ? await fetch(`/api/omni/v1/conversations/${encodeURIComponent(actual.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cambio),
      }).catch(() => null)
    : await fetch("/api/omni/v1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lineId, chatId: chat, ...cambio }),
      }).catch(() => null);
  if (!r) return { error: "No hay conexión con el servidor." };
  const cuerpo = (await r.json().catch(() => null)) as
    { data?: Conversacion; detail?: string } | null;
  if (!r.ok || !cuerpo?.data) {
    return { error: cuerpo?.detail ? `No se pudo: ${cuerpo.detail}.` : "No se pudo guardar el cambio." };
  }
  return { conv: cuerpo.data };
}
