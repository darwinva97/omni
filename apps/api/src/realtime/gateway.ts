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
  if (t.allowedLines.length > 0 && !t.allowedLines.includes(e.lineId)) return false;

  if (t.allowedChats.length > 0) {
    const chat = chatDe(e);
    // Un evento sin chat identificable —el estado de la sesión, por ejemplo— NO
    // se entrega a una credencial acotada a chats: en la duda, no se enseña.
    if (!chat) return false;
    if (!t.allowedChats.includes(chat)) return false;
  }
  return true;
}

function chatDe(e: EventEnvelope): string | null {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const key = (d["key"] ?? {}) as Record<string, unknown>;
  const candidato = key["remoteJid"] ?? d["chat"] ?? d["group"] ?? d["address"];
  return typeof candidato === "string" && candidato.length > 0 ? candidato : null;
}

export interface Suscripcion {
  /** Patrones de evento. Vacío = todos, igual que en los webhooks. */
  readonly events: readonly string[];
  /** Líneas concretas. Vacío = todas las que la credencial alcance. */
  readonly lines: readonly string[];
}

export const SUSCRIPCION_TODO: Suscripcion = { events: [], lines: [] };

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
  ): Promise<void> {
    this.#conexiones.set(id, { ticket, suscripcion: SUSCRIPCION_TODO, enviar });

    const existente = this.#porOrg.get(ticket.orgId);
    if (existente) {
      existente.n++;
      return;
    }
    const off = await this.#bus.subscribe<EventEnvelope>(`org:${ticket.orgId}`, (e) => {
      this.#repartir(e);
    });
    this.#porOrg.set(ticket.orgId, { n: 1, off });
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
