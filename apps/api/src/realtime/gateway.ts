import { matchesAny, type EventEnvelope } from "@omni/shared";
import type { Bus } from "@omni/platform";
import type { TicketPayload } from "./tickets.js";

/**
 * Filtro de lo que una conexión puede ver.
 *
 * El WebSocket autentica FUERA del guard REST, así que aplica sus propias
 * reglas: heredarlas "por estar dentro" dejaría a una credencial acotada
 * viendo por aquí lo que no ve por HTTP. Es el mismo principio que en el
 * montaje MCP.
 */
export function visibleFor(t: TicketPayload, e: EventEnvelope): boolean {
  if (e.orgId !== t.orgId) return false;
  const limitada = t.lineScoped ?? t.allowedLines.length > 0;
  if (limitada && !t.allowedLines.includes(e.lineId)) return false;
  // En una línea suya, ni el QR ni el límite por chats cuentan: es entera.
  const entera = t.fullLines?.includes(e.lineId) ?? false;
  // El QR de enlace no sale hacia quien no puede enlazar: quien lo escanea se queda la línea.
  if (t.sinEnlace && !entera && e.event === "session.qr") return false;

  if (t.allowedChats.length > 0 && !entera) {
    // Las notas internas son lo que el equipo dice DEL cliente: una clave
    // acotada a chats no las lee por HTTP, y por aquí tampoco.
    if (e.event.startsWith("note.")) return false;
    const chats = chatsDe(e);
    // Un evento sin chat identificable —el estado de la sesión, por ejemplo— NO
    // se entrega a una credencial acotada a chats: en la duda, no se enseña.
    if (chats.length === 0) return false;
    if (!chats.some((c) => t.allowedChats.includes(c))) return false;
  }
  return true;
}

/**
 * Las direcciones que nombran el chat de un evento.
 *
 * Puede haber dos de la MISMA persona: `remoteJid`, por donde escribió, y
 * `chatId`, la conversación donde el motor lo guardó —su teléfono o su LID—.
 * El evento de una conversación de atención solo trae `chatId`. Basta con que
 * una esté al alcance de la credencial: las dos son la misma conversación.
 */
function chatsDe(e: EventEnvelope): string[] {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const key = (d["key"] ?? {}) as Record<string, unknown>;
  const principal = key["remoteJid"] ?? d["chat"] ?? d["group"] ?? d["address"];
  return [d["chatId"], principal]
    .filter((c): c is string => typeof c === "string" && c.length > 0);
}

export interface Suscripcion {
  /** Patrones de evento. Vacío = todos, igual que en los webhooks. */
  readonly events: readonly string[];
  /** Líneas concretas. Vacío = todas las que la credencial alcance. */
  readonly lines: readonly string[];
}

export const SUSCRIPCION_TODO: Suscripcion = { events: [], lines: [] };

/**
 * Tema del bus por el que se avisa de que el acceso de una persona cambió: se
 * le acotó, cambió de rol o se la quitó del equipo.
 *
 * El billete fija el alcance al ABRIR el socket, así que sin este aviso una
 * persona a la que acabas de quitarle un chat seguiría recibiendo sus mensajes
 * por el socket que ya tenía abierto. Va por el bus y no por memoria porque la
 * API puede correr en varias réplicas y el socket puede estar en otra.
 */
export const temaDeAcceso = (orgId: string): string => `acceso:${orgId}`;

export interface CambioDeAcceso {
  readonly userId: string;
}

export function pasaSuscripcion(s: Suscripcion, e: EventEnvelope): boolean {
  if (s.lines.length > 0 && !s.lines.includes(e.lineId)) return false;
  return matchesAny(e.event, s.events);
}

/**
 * Reparte los eventos del bus a las conexiones abiertas.
 *
 * Se suscribe UNA vez al bus por organización, no una por conexión: con
 * doscientas pestañas abiertas, doscientas suscripciones a Postgres serían
 * doscientas conexiones a la base.
 */
export class RealtimeGateway {
  readonly #bus: Bus;
  readonly #conexiones = new Map<string, {
    ticket: TicketPayload;
    suscripcion: Suscripcion;
    enviar: (texto: string) => void;
    cerrar: () => void;
  }>();
  readonly #porOrg = new Map<string, { n: number; off: () => Promise<void> }>();

  constructor(bus: Bus) {
    this.#bus = bus;
  }

  get conexionesAbiertas(): number {
    return this.#conexiones.size;
  }

  async añadir(
    id: string, ticket: TicketPayload, enviar: (texto: string) => void,
    cerrar: () => void = () => {},
  ): Promise<void> {
    this.#conexiones.set(id, { ticket, suscripcion: SUSCRIPCION_TODO, enviar, cerrar });

    const existente = this.#porOrg.get(ticket.orgId);
    if (existente) {
      existente.n++;
      return;
    }
    const offEventos = await this.#bus.subscribe<EventEnvelope>(`org:${ticket.orgId}`, (e) => {
      this.#repartir(e);
    });
    const offAcceso = await this.#bus.subscribe<CambioDeAcceso>(temaDeAcceso(ticket.orgId), (c) => {
      this.#expulsar(ticket.orgId, c.userId);
    });
    const off = async (): Promise<void> => {
      await Promise.all([offEventos(), offAcceso()]);
    };
    this.#porOrg.set(ticket.orgId, { n: 1, off });
  }

  /**
   * Cierra los sockets de una persona. NO se le deja de mandar en silencio: se
   * cierra, para que el panel vuelva a pedir billete y reciba, con él, el
   * alcance de ahora —o un 401 si ya no está en el equipo—.
   */
  #expulsar(orgId: string, userId: string): void {
    for (const [id, conexion] of this.#conexiones) {
      if (conexion.ticket.orgId !== orgId || conexion.ticket.userId !== userId) continue;
      this.#conexiones.delete(id);
      try {
        conexion.cerrar();
      } catch {
        // Ya estaba cerrado: lo que importa es que no reciba más.
      }
      const org = this.#porOrg.get(orgId);
      if (org) org.n--;
    }
    const org = this.#porOrg.get(orgId);
    if (org && org.n <= 0) {
      this.#porOrg.delete(orgId);
      void org.off().catch(() => {});
    }
  }

  async quitar(id: string): Promise<void> {
    const conexion = this.#conexiones.get(id);
    if (!conexion) return;
    this.#conexiones.delete(id);

    const org = this.#porOrg.get(conexion.ticket.orgId);
    if (!org) return;
    org.n--;
    if (org.n <= 0) {
      this.#porOrg.delete(conexion.ticket.orgId);
      await org.off().catch(() => {});
    }
  }

  suscribir(id: string, suscripcion: Suscripcion): void {
    const conexion = this.#conexiones.get(id);
    if (conexion) this.#conexiones.set(id, { ...conexion, suscripcion });
  }

  #repartir(e: EventEnvelope): void {
    const texto = JSON.stringify({ type: "event", event: e.event, lineId: e.lineId, timestamp: e.timestamp, data: e.data });
    for (const conexion of this.#conexiones.values()) {
      if (!visibleFor(conexion.ticket, e)) continue;
      if (!pasaSuscripcion(conexion.suscripcion, e)) continue;
      try {
        conexion.enviar(texto);
      } catch {
        // Una conexión rota no puede impedir que el resto reciba.
      }
    }
  }

  async cerrar(): Promise<void> {
    for (const org of this.#porOrg.values()) await org.off().catch(() => {});
    this.#porOrg.clear();
    this.#conexiones.clear();
  }
}

/**
 * Mensajes que el cliente puede mandar por el socket.
 *
 * Deliberadamente pocos: el WebSocket es para RECIBIR. Enviar mensajes va por
 * HTTP, donde hay idempotencia, reintentos y códigos de error — cosas que un
 * socket no da gratis.
 */
export type MensajeCliente =
  | { type: "subscribe"; events?: string[]; lines?: string[] }
  | { type: "ping" };

export function parseMensajeCliente(crudo: string): MensajeCliente | null {
  try {
    const m = JSON.parse(crudo) as MensajeCliente;
    if (m.type === "subscribe" || m.type === "ping") return m;
    return null;
  } catch {
    return null;
  }
}
