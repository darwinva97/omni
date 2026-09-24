import { z } from "zod";

/**
 * Catálogo de eventos. Superconjunto de los 22 de crafter y de los de wapi-next.
 *
 * Nombres en `dominio.hecho`, en pasado cuando describen algo ya ocurrido. Un
 * consumidor se suscribe a nombres exactos o a un dominio entero con `message.*`.
 */
export const eventNames = [
  // sesión / línea
  "session.qr",
  "session.connected",
  "session.disconnected",
  "session.status",
  "session.error",
  "session.logged_out",
  // mensajes
  "message.received",
  "message.sent",
  "message.upsert",
  "message.updated",
  "message.deleted",
  "message.receipt",
  "message.reaction",
  "message.failed",
  // chats
  "chat.updated",
  "chat.read",
  "chat.archived",
  // grupos
  "group.created",
  "group.updated",
  "group.participants",
  // contactos
  "contact.updated",
  "contact.blocked",
  // llamadas
  "call.received",
  "call.updated",
  // varios
  "presence.updated",
  "history.synced",
  /*
   * Deliberadamente AUSENTES hasta que exista quien los emita:
   *
   * `poll.vote` — WhatsApp cifra los votos y agregarlos es frágil; anunciarlo
   *   sin implementarlo dejaría a alguien esperando un evento que no llega.
   * `label.updated` — las etiquetas serán nuestras, no del protocolo, y
   *   todavía no hay nada que las mueva.
   * `newsletter.updated` — los canales aún no están.
   *
   * Un evento al que uno puede suscribirse y no recibir nunca es peor que su
   * ausencia: el webhook se configura, se da por bueno y falla en silencio.
   */
] as const;

export const EventName = z.enum(eventNames);
export type EventName = z.infer<typeof EventName>;

/**
 * Patrón de suscripción: un nombre exacto, un comodín de dominio (`message.*`)
 * o `*` para todo. Un array vacío significa "todo", que NO es lo mismo que
 * la ausencia del campo — la distinción viene de crafter y evita el fallo de
 * configurar un webhook que no entrega nada sin decirlo.
 */
export const EventPattern = z.string().regex(/^(\*|[a-z_]+\.(\*|[a-z_]+))$/);
export type EventPattern = z.infer<typeof EventPattern>;

export function matchesPattern(event: EventName, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === event) return true;
  const star = pattern.indexOf(".*");
  if (star > 0 && star === pattern.length - 2) {
    return event.startsWith(pattern.slice(0, star + 1));
  }
  return false;
}

export function matchesAny(event: EventName, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true; // vacío = todo, por contrato explícito
  return patterns.some((p) => matchesPattern(event, p));
}

/** Sobre de evento. Es lo que llega al webhook y lo que viaja por el bus. */
export interface EventEnvelope<T = unknown> {
  readonly id: string;
  readonly event: EventName;
  readonly orgId: string;
  readonly lineId: string;
  /** Epoch en milisegundos. */
  readonly timestamp: number;
  readonly data: T;
}

export const eventDomain = (e: EventName): string => e.slice(0, e.indexOf("."));
