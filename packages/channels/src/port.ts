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
  /** Archiva o desarchiva EN LA RED, no en nuestro espejo. */
  archiveChat?(lineId: LineId, chat: Address, archivar: boolean, anchor: readonly ChatAnchorMessage[]): Promise<void>;
  /** Silencia hasta un instante dado; `null` la desilencia. */
  muteChat?(lineId: LineId, chat: Address, hasta: number | null): Promise<void>;
  /**
   * Mensajes efímeros. `segundos` a 0 los desactiva.
   *
   * WhatsApp solo admite unos pocos valores (24 h, 7 días, 90 días); mandar
   * otro no falla, se ignora, que es peor. El driver lo valida.
   */
  setEphemeral?(lineId: LineId, chat: Address, segundos: number): Promise<void>;
  blockContact?(lineId: LineId, address: Address, bloquear: boolean): Promise<void>;
  contactProfile?(lineId: LineId, address: Address): Promise<ContactProfile>;
  /**
   * URL de la foto de perfil, o `null` si no tiene o no se puede ver.
   *
   * Sirve igual para una persona y para un grupo. Caduca, así que quien la
   * reciba debe descargarla, no guardarla: una URL de WhatsApp guardada es una
   * foto rota a los pocos días.
   */
  profilePictureUrl?(lineId: LineId, address: Address): Promise<string | null>;
  /**
   * Vuelve a pedir la agenda a la red.
   *
   * Los nombres que TÚ guardaste no llegan en los mensajes: viajan en la
   * sincronización de estado, que ocurre al enlazar y no se repite al
   * reconectar. Sin esto, una línea enlazada antes de que existiera esta
   * función se queda sin un solo nombre de agenda para siempre.
   */
  resyncContacts?(lineId: LineId): Promise<void>;
  /** Reenvía un mensaje ya existente a otra conversación. */
  forwardMessage?(lineId: LineId, origen: ForwardSource, hacia: Address): Promise<SendReceipt>;
  /** Etiquetas de WhatsApp Business, las de la propia red. */
  listNetworkLabels?(lineId: LineId): Promise<readonly NetworkLabel[]>;
  /** Publica en un canal del que se es dueño o administrador. */
  createNewsletter?(lineId: LineId, name: string, description?: string): Promise<NewsletterMetadata>;

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
   * Descarga y descifra el medio de un mensaje entrante.
   *
   * WhatsApp NO manda el fichero: manda una referencia cifrada que solo el
   * cliente enlazado puede resolver, y que caduca. Sin esto, una foto que
   * llega es una fila en la base sin ninguna forma de ver la foto.
   *
   * Devuelve `null` cuando el mensaje sencillamente no lleva medio; los fallos
   * de descarga se lanzan, para que el reintento los vea.
   */
  downloadMedia?(lineId: LineId, raw: unknown): Promise<DownloadedMedia | null>;

  /**
   * Comunidades: grupos de grupos.
   *
   * Enlazar un grupo a una comunidad NO es añadir un participante, y por eso
   * no se cuelga de `group.*`: son dos pertenencias distintas que se pueden
   * cambiar por separado.
   */
  communityMetadata?(lineId: LineId, community: Address): Promise<CommunityMetadata>;
  listCommunities?(lineId: LineId): Promise<readonly CommunityMetadata[]>;
  createCommunity?(lineId: LineId, subject: string, description: string): Promise<CommunityMetadata>;
  linkGroupToCommunity?(lineId: LineId, group: Address, community: Address): Promise<void>;
  unlinkGroupFromCommunity?(lineId: LineId, group: Address, community: Address): Promise<void>;
  leaveCommunity?(lineId: LineId, community: Address): Promise<void>;

  /**
   * Catálogo de WhatsApp Business.
   *
   * Solo existe en cuentas de empresa. Leerlo de OTRA cuenta es legítimo —es
   * público—, así que las lecturas admiten de quién.
   */
  listProducts?(lineId: LineId, de: Address | null, limite: number): Promise<readonly Product[]>;
  listCollections?(lineId: LineId, de: Address | null, limite: number): Promise<readonly Collection[]>;
  createProduct?(lineId: LineId, input: ProductInput): Promise<Product>;
  updateProduct?(lineId: LineId, productId: string, input: ProductInput): Promise<Product>;
  deleteProducts?(lineId: LineId, productIds: readonly string[]): Promise<number>;
  /** Un pedido llega dentro de un mensaje, con un testigo de un solo uso. */
  orderDetails?(lineId: LineId, orderId: string, token: string): Promise<OrderDetails>;

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
  rejectCall?(lineId: LineId, callId: string, from: Address): Promise<void>;
  fetchHistory?(lineId: LineId, chat: Address, before: number, count: number): Promise<void>;
}

export interface DownloadedMedia {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly fileName?: string;
}

export interface CommunityMetadata {
  readonly address: Address;
  readonly subject: string;
  readonly description?: string;
  readonly owner?: Address;
  /**
   * Los grupos que cuelgan de ella.
   *
   * Vacío significa "ninguno", no "no lo sabemos": quien no pueda enumerarlos
   * no debe declarar `community.read`.
   */
  readonly linkedGroups: readonly { address: Address; subject: string; size?: number }[];
  readonly size?: number;
}

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** En la unidad menor de la moneda: céntimos, no euros. */
  readonly price: number;
  readonly currency: string;
  readonly retailerId?: string;
  readonly url?: string;
  readonly imageUrls: readonly string[];
  readonly hidden?: boolean;
  readonly availability?: string;
  /** WhatsApp revisa cada producto; hasta que lo aprueba no se ve. */
  readonly reviewStatus?: string;
}

export interface ProductInput {
  readonly name: string;
  readonly description: string;
  readonly price: number;
  readonly currency: string;
  readonly imageUrls: readonly string[];
  readonly retailerId?: string;
  readonly url?: string;
  readonly hidden?: boolean;
  /** Código ISO del país de origen. Ausente = sin país. */
  readonly originCountryCode?: string;
}

export interface Collection {
  readonly id: string;
  readonly name: string;
  readonly products: readonly Product[];
  readonly status?: string;
}

export interface OrderDetails {
  readonly currency: string;
  readonly total: number;
  readonly products: readonly {
    id: string; name: string; quantity: number; price: number; currency: string; imageUrl?: string;
  }[];
}

export interface ForwardSource {
  readonly chat: Address;
  readonly providerMessageId: string;
  /**
   * El mensaje original tal cual llegó, cuando lo conservamos.
   *
   * Baileys no reenvía por identificador: necesita el objeto entero. Guardamos
   * el de los mensajes entrantes; de los que enviamos nosotros, no, y ahí el
   * driver dice que no en vez de reenviar algo distinto de lo que se pidió.
   */
  readonly raw?: unknown;
}

export interface ContactProfile {
  readonly address: Address;
  readonly name?: string;
  /** URL de la foto. Puede caducar: no se guarda como si fuera permanente. */
  readonly pictureUrl?: string;
  readonly about?: string;
  readonly isBusiness?: boolean;
}

export interface NetworkLabel {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
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
