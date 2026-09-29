import type {
  Address, Capability, ChannelDescriptor, ChannelKind,
  DeliveryState, EventEnvelope, EventName, LineId, MessageKind, SendMessageInput,
} from "@omni/shared";
import { CapabilityError } from "@omni/shared";

/**
 * EL PUERTO.
 *
 * Todo el sistema habla con los canales a través de esta interfaz. Sin ella,
 * "tres transportes de WhatsApp más seis canales" son nueve casos especiales
 * enredados por todo el código; con ella son nueve implementaciones de un
 * contrato, y el resto del sistema no sabe —ni necesita saber— cuál hay debajo.
 */

export type LineStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "awaiting-link"; qr?: string; pairingCode?: string }
  | { state: "connected"; self: Address; pushName?: string }
  | { state: "logged-out"; reason: string };

export interface ConnectRequest {
  readonly lineId: LineId;
  /** Credenciales persistidas de un enlace anterior. Ausentes en el primer enlace. */
  readonly credentials: Uint8Array | null;
  /** Se llama cada vez que el driver produce credenciales nuevas; debe persistirlas. */
  readonly saveCredentials: (blob: Uint8Array) => Promise<void>;
  /** Configuración propia del driver (proxy, token de Cloud API, servidor SMTP…). */
  readonly config: Readonly<Record<string, unknown>>;
}

export interface ConnectResult {
  readonly status: LineStatus;
}

/** Orden de envío ya validada y resuelta: el driver no vuelve a validar. */
export interface OutboundCommand {
  readonly lineId: LineId;
  readonly to: Address;
  /** Idempotencia de extremo a extremo. Dos órdenes con el mismo valor son una. */
  readonly clientMessageId: string;
  readonly kind: MessageKind;
  readonly input: SendMessageInput;
  /** Bytes ya resueltos cuando el contenido es un medio; el driver no descarga nada. */
  readonly media?: { readonly bytes: Uint8Array; readonly mimeType: string; readonly fileName?: string };
}

export interface SendReceipt {
  /** El identificador que asigna la red remota. */
  readonly providerMessageId: string;
  readonly state: DeliveryState;
  readonly timestamp: number;
}

export type EventHandler = (envelope: EventEnvelope) => void | Promise<void>;
export type Unsubscribe = () => void;

/** Operaciones opcionales. Cada una está ligada a la capacidad que la habilita. */
export interface ChannelDriverOptional {
  editMessage?(lineId: LineId, chat: Address, providerMessageId: string, text: string): Promise<void>;
  deleteMessage?(lineId: LineId, chat: Address, providerMessageId: string): Promise<void>;
  react?(lineId: LineId, chat: Address, providerMessageId: string, emoji: string): Promise<void>;
  markRead?(lineId: LineId, chat: Address, providerMessageIds: readonly string[]): Promise<void>;
  setPresence?(lineId: LineId, chat: Address, presence: "composing" | "recording" | "paused"): Promise<void>;
  checkContact?(lineId: LineId, address: Address): Promise<{ exists: boolean; address: Address | null }>;
  groupMetadata?(lineId: LineId, group: Address): Promise<GroupMetadata>;
  createGroup?(lineId: LineId, subject: string, participants: readonly Address[]): Promise<GroupMetadata>;
  /** Cambia asunto y/o descripción EN LA RED, no en nuestro espejo. */
  updateGroup?(lineId: LineId, group: Address, patch: GroupPatch): Promise<void>;
  leaveGroup?(lineId: LineId, group: Address): Promise<void>;
  /** Código de invitación vigente; lo devuelve, no lo rota. */
  groupInviteCode?(lineId: LineId, group: Address): Promise<string>;
  /** Rota el código: el anterior deja de servir. Devuelve el nuevo. */
  revokeGroupInvite?(lineId: LineId, group: Address): Promise<string>;
  joinGroupWithCode?(lineId: LineId, code: string): Promise<Address>;
  listGroups?(lineId: LineId): Promise<readonly GroupMetadata[]>;
  updateParticipants?(
    lineId: LineId, group: Address, participants: readonly Address[],
    action: "add" | "remove" | "promote" | "demote",
  ): Promise<readonly { address: Address; ok: boolean; reason?: string }[]>;
  /**
   * Vacía una conversación en la red.
   *
   * `anchor` son los últimos mensajes conocidos. Suena a detalle ajeno, pero no
   * lo es: WhatsApp no borra "hasta ahora", borra hasta un punto concreto del
   * historial, y sin ese punto la operación no se puede expresar. Un driver que
   * no lo necesite simplemente lo ignora.
   */
  clearChat?(lineId: LineId, chat: Address, anchor: readonly ChatAnchorMessage[]): Promise<void>;

  /**
   * Canales (newsletters). Son de UNA dirección: el dueño publica y el resto
   * lee, así que leer y publicar son capacidades distintas —`newsletter.read`
   * y `newsletter.send`— y casi ningún transporte tiene la segunda.
   */
  newsletterMetadata?(lineId: LineId, newsletter: Address): Promise<NewsletterMetadata>;
  /** Por enlace de invitación, que es como circulan de verdad. */
  newsletterByInvite?(lineId: LineId, code: string): Promise<NewsletterMetadata>;
  followNewsletter?(lineId: LineId, newsletter: Address): Promise<void>;
  unfollowNewsletter?(lineId: LineId, newsletter: Address): Promise<void>;
  createNewsletter?(lineId: LineId, name: string, description?: string): Promise<NewsletterMetadata>;
  rejectCall?(lineId: LineId, callId: string, from: Address): Promise<void>;
  fetchHistory?(lineId: LineId, chat: Address, before: number, count: number): Promise<void>;
}

export interface ChatAnchorMessage {
  readonly providerMessageId: string;
  readonly fromMe: boolean;
  /** En milisegundos, como todo lo demás del sistema. */
  readonly timestamp: number;
}

export interface NewsletterMetadata {
  readonly address: Address;
  readonly name: string;
  readonly description?: string;
  /** Código del enlace `whatsapp.com/channel/...`, cuando la red lo da. */
  readonly inviteCode?: string;
  readonly subscribers?: number;
  readonly verified?: boolean;
  /** Qué somos nosotros en ese canal. Decide si publicar es siquiera posible. */
  readonly role?: "owner" | "admin" | "subscriber" | "guest";
  readonly createdAt?: number;
}

export interface GroupPatch {
  readonly subject?: string;
  readonly description?: string;
}

export interface GroupMetadata {
  readonly address: Address;
  readonly subject: string;
  readonly description?: string;
  readonly owner?: Address;
  readonly participants: readonly { address: Address; role: "member" | "admin" | "superadmin" }[];
  /**
   * Cuántos miembros tiene, cuando la red lo dice sin dar la lista. Telegram
   * da el número pero solo enumera a los administradores, así que `participants`
   * vacío con `size` puesto es un estado legítimo, no un fallo.
   */
  readonly size?: number;
  readonly createdAt?: number;
}

export interface ChannelDriver extends ChannelDriverOptional {
  readonly descriptor: ChannelDescriptor;
  connect(req: ConnectRequest): Promise<ConnectResult>;
  disconnect(lineId: LineId): Promise<void>;
  status(lineId: LineId): LineStatus;
  send(cmd: OutboundCommand): Promise<SendReceipt>;
  subscribe(handler: EventHandler): Unsubscribe;
}

export const supports = (d: ChannelDriver, c: Capability): boolean => d.descriptor.capabilities.has(c);

/**
 * Comprueba una capacidad antes de actuar. Falla con 422 explicando qué
 * transporte sí la tiene, en vez de dar un 500 o —peor— no hacer nada en silencio.
 */
export function assertCapability(
  driver: ChannelDriver,
  capability: Capability,
  alternatives: readonly ChannelKind[] = [],
): void {
  if (!driver.descriptor.capabilities.has(capability)) {
    throw new CapabilityError(capability, driver.descriptor.kind, alternatives);
  }
}

/** Emisor de eventos compartido por los drivers, para no repetir el mismo bucle. */
export class EventEmitterBase {
  readonly #handlers = new Set<EventHandler>();

  subscribe(handler: EventHandler): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  protected async emit<T>(
    event: EventName, orgId: string, lineId: string, data: T,
  ): Promise<void> {
    const envelope: EventEnvelope<T> = {
      id: crypto.randomUUID(),
      event, orgId, lineId,
      timestamp: Date.now(),
      data,
    };
    // Un manejador que revienta no puede tumbar al resto ni a la ingesta.
    await Promise.all(
      [...this.#handlers].map(async (h) => {
        try {
          await h(envelope as EventEnvelope);
        } catch {
          /* el transporte de eventos registra; aquí solo aislamos */
        }
      }),
    );
  }
}
