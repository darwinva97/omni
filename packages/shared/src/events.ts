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
  /*
   * Un voto NO es un mensaje.
   *
   * WhatsApp lo entrega por el mismo canal, cifrado y apuntando a la encuesta
   * a la que responde. Guardarlo como mensaje llenaba el hilo: una encuesta de
   * un grupo de cincuenta personas son cincuenta burbujas vacías.
   */
  "poll.vote",
  // chats
  "chat.updated",
  "chat.read",
  "chat.archived",
  /*
   * Conversaciones: el episodio de atención dentro de un chat.
   *
   * Uno solo para todo cambio —se abre, se reabre, se asigna, se resuelve—
   * con la conversación entera en `data`: quien lo recibe pinta el estado
   * nuevo sin tener que adivinar qué campo cambió ni pedirlo aparte.
   */
  "conversation.updated",
  // grupos
  "group.created",
  "group.updated",
  "group.participants",
  // comunidades
  "community.updated",
  // canales (newsletters)
  "newsletter.created",
  "newsletter.updated",
  // contactos
  "contact.updated",
  "contact.blocked",
  // llamadas
  "call.received",
  "call.updated",
  // varios
  "presence.updated",
  "history.synced",
  "label.updated",
  /*
   * La norma de esta lista: un evento entra cuando existe quien lo emite.
   *
   * Uno al que uno puede suscribirse y no recibir nunca es peor que su
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
