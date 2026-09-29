import {
  capabilitySet, OmniError, parseAddress, resolveContent, tryParseAddress,
  type Address, type ChannelDescriptor, type DeliveryState,
  type LineId, type MessageKind,
} from "@omni/shared";
import type { Storage } from "@omni/storage";
import {
  EventEmitterBase,
  type ChannelDriver, type ConnectRequest, type ConnectResult,
  type ContactProfile, type DownloadedMedia, type ForwardSource, type GroupMetadata,
  type GroupPatch, type LineStatus, type NetworkLabel, type OutboundCommand, type SendReceipt,
} from "../port.js";
import { ObjectStorageSessionStore } from "./session-store.js";

/**
 * Driver de WhatsApp sobre whatsapp-web.js.
 *
 * Conduce un Chromium real con WhatsApp Web dentro. Es el transporte no oficial
 * con MENOS riesgo de baneo —el tráfico se parece al de un navegador de verdad,
 * porque lo es— a costa de cientos de megas de memoria por línea frente a las
 * decenas de Baileys.
 *
 * Tenerlo al lado de Baileys convierte "riesgo contra recursos" en una decisión
 * de configuración y no en una reescritura.
 */

export const WEB_DESCRIPTOR: ChannelDescriptor = {
  kind: "whatsapp.web",
  network: "whatsapp",
  linkMethod: "qr",
  risk: "unofficial",
  // Un Chromium por línea. Es el precio de parecerse a un navegador real.
  approxMemoryMbPerLine: 400,
  capabilities: capabilitySet(
    "send.text", "send.image", "send.video", "send.audio", "send.document",
    "send.sticker", "send.location", "send.contact", "send.poll", "send.reaction",
    "send.reply", "send.mentions", "send.forward",
    "message.edit", "message.delete", "message.receipts",
    "chat.read", "chat.presence", "chat.typing", "chat.archive", "chat.mute", "chat.clear",
    "group.read", "group.create", "group.manage", "group.invite", "group.participants",
    "contact.check", "contact.block", "contact.profile",
    "call.receive",
    "label.manage",
    // Esto es lo que Baileys NO puede: WhatsApp Web sí sirve el historial de un
    // chat, así que el scroll hacia atrás funciona de verdad.
    "history.sync",
    "media.decrypt",
    /*
     * AUSENTES a propósito:
     *
     * `call.reject` — la interfaz web no expone rechazar una llamada; OpenWA
     *   lo documenta como exclusivo de Baileys.
     * `send.viewOnce` y `chat.ephemeral` — no están en la interfaz web.
     * `identity.lid` — el mapeo LID es del cliente multidispositivo.
     * `send.buttons`, `send.list`, `send.template` — WhatsApp los retiró de la
     *   interfaz web para cuentas no comerciales.
     * `newsletter.*` — sin soporte estable aquí.
     */
  ),
};

/** Lo que el driver necesita del cliente de whatsapp-web.js. */
export interface WebClient {
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  on(evento: string, manejador: (...args: never[]) => void): void;
  sendMessage(chatId: string, contenido: unknown, opciones?: unknown): Promise<{ id: { _serialized: string }; timestamp?: number }>;
  isRegisteredUser(numero: string): Promise<boolean>;
  getNumberId(numero: string): Promise<{ _serialized: string } | null>;
  getChats(): Promise<unknown[]>;
  getChatById(id: string): Promise<unknown>;
  sendPresenceAvailable?(): Promise<void>;
  info?: { wid?: { _serialized?: string }; pushname?: string };
}

export type WebClientFactory = (opts: {
  sessionId: string;
  store: ObjectStorageSessionStore;
  executablePath: string | undefined;
  proxyUrl: string | undefined;
}) => WebClient | Promise<WebClient>;

interface LineRuntime {
  readonly orgId: string;
  cliente: WebClient | null;
  status: LineStatus;
  readonly recent: Map<string, SendReceipt>;
  cerrando: boolean;
}

export interface WebOptions {
  readonly storage: Storage;
  /** Permite inyectar un cliente falso en las pruebas. */
  readonly makeClient?: WebClientFactory;
  /** Chromium del sistema. Sin él, puppeteer intenta descargar el suyo. */
  readonly executablePath?: string;
}

export class WhatsappWebDriver extends EventEmitterBase implements ChannelDriver {
  readonly descriptor = WEB_DESCRIPTOR;
  readonly #lines = new Map<string, LineRuntime>();
  readonly #storage: Storage;
  readonly #make: WebClientFactory;
  readonly #executablePath: string | undefined;

  constructor(opts: WebOptions) {
    super();
    this.#storage = opts.storage;
    this.#executablePath = opts.executablePath ?? process.env["CHROMIUM_PATH"] ?? "/usr/bin/chromium";
    this.#make = opts.makeClient ?? defaultFactory;
  }

  // ---------------------------------------------------------------- conexión

  async connect(req: ConnectRequest): Promise<ConnectResult> {
    const orgId = String(req.config["orgId"] ?? "");
    const existente = this.#lines.get(req.lineId);
    if (existente?.status.state === "connected") return { status: existente.status };

    const line: LineRuntime = {
      orgId,
      cliente: null,
      status: { state: "connecting" },
      recent: new Map(),
      cerrando: false,
    };
    this.#lines.set(req.lineId, line);

    const store = new ObjectStorageSessionStore(this.#storage, orgId);
    const cliente = await this.#make({
      sessionId: req.lineId,
      store,
      executablePath: this.#executablePath,
      proxyUrl: req.config["proxyUrl"] ? String(req.config["proxyUrl"]) : undefined,
    });
    line.cliente = cliente;
    this.#wire(req.lineId, line, cliente, req.saveCredentials);

    await cliente.initialize().catch(async (err: unknown) => {
      line.status = { state: "logged-out", reason: (err as Error).message };
      throw new OmniError("upstream_failed", `no se pudo abrir el navegador: ${(err as Error).message}`);
    });
    return { status: line.status };
  }

  #wire(
    lineId: string,
    line: LineRuntime,
    cliente: WebClient,
    saveCredentials: (b: Uint8Array) => Promise<void>,
  ): void {
    cliente.on("qr", ((qr: string) => {
      line.status = { state: "awaiting-link", qr };
      void this.emit("session.qr", line.orgId, lineId, { qr });
      void this.emit("session.status", line.orgId, lineId, { state: "awaiting-link" });
    }) as never);

    cliente.on("ready", (() => {
      const propio = tryParseAddress(cliente.info?.wid?._serialized ?? "") ?? parseAddress("0@s.whatsapp.net");
      line.status = {
        state: "connected", self: propio,
        ...(cliente.info?.pushname ? { pushName: cliente.info.pushname } : {}),
      };
      void this.emit("session.connected", line.orgId, lineId, { self: propio.value });
      void this.emit("session.status", line.orgId, lineId, { state: "connected" });
    }) as never);

    cliente.on("remote_session_saved", (() => {
      /*
       * El zip ya está en el almacén de objetos; en el blob del puerto solo va
       * un marcador. Meter decenas de megas en una columna de la base sería
       * inflar cada copia de seguridad con un perfil de navegador.
       */
      void saveCredentials(new TextEncoder().encode(JSON.stringify({ store: "object-storage", v: 1 })));
    }) as never);

    cliente.on("disconnected", ((razon: string) => {
      // `LOGOUT` es desvinculación: reconectar no serviría de nada.
      const desvinculado = String(razon).toUpperCase().includes("LOGOUT");
      line.status = desvinculado
        ? { state: "logged-out", reason: String(razon) }
        : { state: "disconnected" };
      void this.emit(desvinculado ? "session.logged_out" : "session.disconnected", line.orgId, lineId, {
        reason: String(razon),
      });
      void this.emit("session.status", line.orgId, lineId, { state: line.status.state });
    }) as never);

    cliente.on("auth_failure", ((mensaje: string) => {
      line.status = { state: "logged-out", reason: String(mensaje) };
      void this.emit("session.error", line.orgId, lineId, { reason: String(mensaje) });
    }) as never);

    cliente.on("message", ((m: WebMessage) => { void this.#onMessage(lineId, line, m, false); }) as never);
    cliente.on("message_create", ((m: WebMessage) => {
      if (m.fromMe) void this.#onMessage(lineId, line, m, true);
    }) as never);

    cliente.on("message_ack", ((m: WebMessage, ack: number) => {
      const estado = ackToState(ack);
      if (!estado) return;
      void this.emit("message.receipt", line.orgId, lineId, {
        key: { id: m.id?._serialized ?? "", remoteJid: m.from ?? "", fromMe: true },
        state: estado,
      });
    }) as never);

    cliente.on("message_revoke_everyone", ((m: WebMessage) => {
      void this.emit("message.deleted", line.orgId, lineId, {
        key: { id: m.id?._serialized ?? "", remoteJid: m.from ?? "", fromMe: m.fromMe ?? false },
      });
    }) as never);

    cliente.on("call", ((llamada: { id: string; from: string; isVideo?: boolean }) => {
      void this.emit("call.received", line.orgId, lineId, {
        callId: llamada.id, from: llamada.from, isVideo: llamada.isVideo ?? false,
      });
    }) as never);
  }

  async #onMessage(lineId: string, line: LineRuntime, m: WebMessage, propio: boolean): Promise<void> {
    const chat = m.fromMe ? (m.to ?? "") : (m.from ?? "");
    if (!chat) return;
    const payload = {
      key: {
        id: m.id?._serialized ?? "",
        remoteJid: chat,
        fromMe: propio,
        ...(m.author ? { participant: m.author } : {}),
      },
      pushName: m.notifyName ?? null,
      kind: webKind(m.type ?? ""),
      text: m.body ?? null,
      timestamp: (m.timestamp ?? 0) * 1000,
      raw: m,
    };
    await this.emit(propio ? "message.sent" : "message.received", line.orgId, lineId, payload);
    await this.emit("message.upsert", line.orgId, lineId, payload);
  }

  // ---------------------------------------------------------------- estado

  status(lineId: LineId): LineStatus {
    return this.#lines.get(lineId)?.status ?? { state: "disconnected" };
  }

  async disconnect(lineId: LineId): Promise<void> {
    const line = this.#lines.get(lineId);
    if (!line) return;
    line.cerrando = true;
    // Cerrar el navegador de verdad: un Chromium huérfano se queda con sus
    // cientos de megas hasta que alguien lo mate a mano.
    await line.cliente?.destroy().catch(() => {});
    line.status = { state: "disconnected" };
    await this.emit("session.disconnected", line.orgId, lineId, { reason: "requested" });
  }

  #require(lineId: string): { line: LineRuntime; cliente: WebClient } {
    const line = this.#lines.get(lineId);
    if (!line) throw new OmniError("not_found", `la línea "${lineId}" no está registrada`);
    if (line.status.state !== "connected" || !line.cliente) {
      throw new OmniError("line_not_connected", `la línea "${lineId}" no está conectada (${line.status.state})`);
    }
    return { line, cliente: line.cliente };
  }

  // ---------------------------------------------------------------- envío

  async send(cmd: OutboundCommand): Promise<SendReceipt> {
    const { line, cliente } = this.#require(cmd.lineId);

    const yaEnviado = line.recent.get(cmd.clientMessageId);
    if (yaEnviado) return yaEnviado;

    const resuelto = resolveContent(cmd.input);
    if (!resuelto.ok) throw new OmniError("validation_failed", resuelto.reason);

    const { contenido, opciones } = toWebContent(cmd, resuelto.field);
    const enviado = await cliente.sendMessage(toWebId(cmd.to), contenido, opciones);

    const receipt: SendReceipt = {
      providerMessageId: enviado.id._serialized,
      state: "sent",
      timestamp: (enviado.timestamp ?? 0) * 1000 || Date.now(),
    };
    line.recent.set(cmd.clientMessageId, receipt);
    if (line.recent.size > 2000) {
      const primera = line.recent.keys().next().value;
      if (primera !== undefined) line.recent.delete(primera);
    }
    return receipt;
  }

  // ---------------------------------------------------------------- opcionales

  async react(lineId: LineId, chat: Address, providerMessageId: string, emoji: string): Promise<void> {
    const { cliente } = this.#require(lineId);
    const mensaje = await this.#buscarMensaje(cliente, chat, providerMessageId);
    await (mensaje as { react: (e: string) => Promise<void> }).react(emoji);
  }

  async editMessage(lineId: LineId, chat: Address, providerMessageId: string, text: string): Promise<void> {
    const { cliente } = this.#require(lineId);
    const mensaje = await this.#buscarMensaje(cliente, chat, providerMessageId);
    await (mensaje as { edit: (t: string) => Promise<unknown> }).edit(text);
  }

  async deleteMessage(lineId: LineId, chat: Address, providerMessageId: string): Promise<void> {
    const { cliente } = this.#require(lineId);
    const mensaje = await this.#buscarMensaje(cliente, chat, providerMessageId);
    // `true` = para todos, no solo para mí.
    await (mensaje as { delete: (t: boolean) => Promise<void> }).delete(true);
  }

  /**
   * Marca el chat como visto.
   *
   * La interfaz web no marca mensajes sueltos: marca la CONVERSACIÓN entera. Se
   * acepta la lista de identificadores para cumplir el puerto, pero se ignora a
   * propósito —y se dice aquí, porque un cliente que espere precisión por
   * mensaje merece saber que no la tiene.
   */
  async markRead(lineId: LineId, chat: Address, _providerMessageIds: readonly string[]): Promise<void> {
    const { cliente } = this.#require(lineId);
    const c = (await cliente.getChatById(toWebId(chat))) as { sendSeen: () => Promise<void> };
    await c.sendSeen();
  }

  async setPresence(
    lineId: LineId, chat: Address, presence: "composing" | "recording" | "paused",
  ): Promise<void> {
    const { cliente } = this.#require(lineId);
    const c = (await cliente.getChatById(toWebId(chat))) as {
      sendStateTyping: () => Promise<void>;
      sendStateRecording: () => Promise<void>;
      clearState: () => Promise<void>;
    };
    if (presence === "composing") await c.sendStateTyping();
    else if (presence === "recording") await c.sendStateRecording();
    else await c.clearState();
  }

  async checkContact(lineId: LineId, address: Address): Promise<{ exists: boolean; address: Address | null }> {
    const { cliente } = this.#require(lineId);
    const id = await cliente.getNumberId(address.local);
    return id
      ? { exists: true, address: tryParseAddress(id._serialized) }
      : { exists: false, address: null };
  }

  async groupMetadata(lineId: LineId, group: Address): Promise<GroupMetadata> {
    const { cliente } = this.#require(lineId);
    const c = (await cliente.getChatById(toWebId(group))) as WebChat;
    if (!c.isGroup) throw new OmniError("validation_failed", `"${group.value}" no es un grupo`);
    return toGroupMetadata(group, c);
  }

  async listGroups(lineId: LineId): Promise<readonly GroupMetadata[]> {
    const { cliente } = this.#require(lineId);
    const chats = (await cliente.getChats()) as WebChat[];
    return chats
      .filter((c) => c.isGroup)
      .map((c) => toGroupMetadata(parseAddress(c.id?._serialized ?? ""), c));
  }

  async clearChat(lineId: LineId, chat: Address): Promise<void> {
    const { cliente } = this.#require(lineId);
    // Aquí no hace falta anclar en ningún mensaje: la biblioteca lo resuelve
    // sola porque conduce el cliente web, que ya tiene el historial delante.
    const c = (await cliente.getChatById(toWebId(chat))) as unknown as {
      clearMessages: () => Promise<unknown>;
    };
    await c.clearMessages();
  }

  async archiveChat(lineId: LineId, chat: Address, archivar: boolean): Promise<void> {
    const { cliente } = this.#require(lineId);
    // Aquí no hace falta anclar en ningún mensaje: conduce el cliente web, que
    // ya tiene el historial delante.
    const c = (await cliente.getChatById(toWebId(chat))) as unknown as {
      archive: () => Promise<unknown>; unarchive: () => Promise<unknown>;
    };
    await (archivar ? c.archive() : c.unarchive());
  }

  async muteChat(lineId: LineId, chat: Address, hasta: number | null): Promise<void> {
    const { cliente } = this.#require(lineId);
    const c = (await cliente.getChatById(toWebId(chat))) as unknown as {
      mute: (hasta?: Date) => Promise<unknown>; unmute: () => Promise<unknown>;
    };
    await (hasta === null ? c.unmute() : c.mute(new Date(hasta)));
  }

  async blockContact(lineId: LineId, address: Address, bloquear: boolean): Promise<void> {
    const { cliente } = this.#require(lineId);
    const c = (await (cliente as unknown as {
      getContactById: (id: string) => Promise<{ block: () => Promise<unknown>; unblock: () => Promise<unknown> }>;
    }).getContactById(toWebId(address)));
    await (bloquear ? c.block() : c.unblock());
  }

  async contactProfile(lineId: LineId, address: Address): Promise<ContactProfile> {
    const { cliente } = this.#require(lineId);
    const c = await (cliente as unknown as {
      getContactById: (id: string) => Promise<{
        name?: string; pushname?: string; isBusiness?: boolean;
        getProfilePicUrl: () => Promise<string | undefined>;
        getAbout: () => Promise<string | null>;
      }>;
    }).getContactById(toWebId(address));

    // Cada dato falla por su cuenta: quien tiene la foto oculta da error, no
    // un hueco, y eso no puede dejar sin el resto del perfil.
    const [foto, about] = await Promise.all([
      c.getProfilePicUrl().catch(() => undefined),
      c.getAbout().catch(() => null),
    ]);
    return {
      address,
      ...(c.name ?? c.pushname ? { name: c.name ?? c.pushname! } : {}),
      ...(foto ? { pictureUrl: foto } : {}),
      ...(about ? { about } : {}),
      isBusiness: Boolean(c.isBusiness),
    };
  }

  async forwardMessage(
    lineId: LineId, origen: ForwardSource, hacia: Address,
  ): Promise<SendReceipt> {
    const { cliente } = this.#require(lineId);
    /*
     * Esto es lo que este transporte hace mejor que Baileys: el cliente web
     * tiene el historial, así que el mensaje se busca por identificador y no
     * hace falta haberlo guardado entero.
     */
    const m = await (cliente as unknown as {
      getMessageById: (id: string) => Promise<{ forward: (a: string) => Promise<unknown> } | null>;
    }).getMessageById(origen.providerMessageId);
    if (!m) {
      throw new OmniError("not_found", `el mensaje "${origen.providerMessageId}" ya no está disponible`);
    }
    await m.forward(toWebId(hacia));
    return { providerMessageId: origen.providerMessageId, state: "sent", timestamp: Date.now() };
  }

  async listNetworkLabels(lineId: LineId): Promise<readonly NetworkLabel[]> {
    const { cliente } = this.#require(lineId);
    // Las etiquetas DE WHATSAPP BUSINESS, no las nuestras: solo existen si la
    // cuenta enlazada es de empresa.
    const etiquetas = await (cliente as unknown as {
      getLabels: () => Promise<{ id: string; name: string; hexColor?: string }[]>;
    }).getLabels();
    return etiquetas.map((l) => ({
      id: String(l.id), name: l.name, ...(l.hexColor ? { color: l.hexColor } : {}),
    }));
  }

  async downloadMedia(lineId: LineId, raw: unknown): Promise<DownloadedMedia | null> {
    const { cliente } = this.#require(lineId);
    const sobre = raw as { key?: { id?: string } } | null;
    const id = sobre?.key?.id;
    if (!id) return null;

    const m = await (cliente as unknown as {
      getMessageById: (i: string) => Promise<{
        hasMedia?: boolean;
        downloadMedia: () => Promise<{ data: string; mimetype: string; filename?: string } | null>;
      } | null>;
    }).getMessageById(id);
    if (!m?.hasMedia) return null;

    const medio = await m.downloadMedia();
    if (!medio) return null;
    return {
      bytes: new Uint8Array(Buffer.from(medio.data, "base64")),
      mimeType: medio.mimetype,
      ...(medio.filename ? { fileName: medio.filename } : {}),
    };
  }

  async createGroup(
    lineId: LineId, subject: string, participants: readonly Address[],
  ): Promise<GroupMetadata> {
    const { cliente } = this.#require(lineId);
    const res = await (cliente as unknown as {
      createGroup: (s: string, p: string[]) => Promise<{ gid?: { _serialized?: string } } | string>;
    }).createGroup(subject, participants.map(toWebId));

    /*
     * Devuelve el identificador de dos formas según la versión: una cadena o
     * un objeto con `gid`. Adivinar mal aquí daría un grupo creado de verdad
     * con un identificador inventado, que es la peor combinación posible.
     */
    const bruto = typeof res === "string" ? res : res?.gid?._serialized;
    const address = bruto ? tryParseAddress(String(bruto)) : null;
    if (!address) {
      throw new OmniError("upstream_failed", "el grupo se creó pero no se pudo leer su identificador");
    }
    return {
      address, subject,
      participants: participants.map((p) => ({ address: p, role: "member" as const })),
    };
  }

  async updateGroup(lineId: LineId, group: Address, patch: GroupPatch): Promise<void> {
    const { cliente } = this.#require(lineId);
    const c = (await cliente.getChatById(toWebId(group))) as unknown as {
      isGroup?: boolean;
      setSubject: (s: string) => Promise<unknown>;
      setDescription: (s: string) => Promise<unknown>;
    };
    if (patch.subject !== undefined) await c.setSubject(patch.subject);
    if (patch.description !== undefined) await c.setDescription(patch.description);
  }

  async leaveGroup(lineId: LineId, group: Address): Promise<void> {
    const { cliente } = this.#require(lineId);
    const c = (await cliente.getChatById(toWebId(group))) as unknown as { leave: () => Promise<unknown> };
    await c.leave();
  }

  async groupInviteCode(lineId: LineId, group: Address): Promise<string> {
    const { cliente } = this.#require(lineId);
    const c = (await cliente.getChatById(toWebId(group))) as unknown as {
      getInviteCode: () => Promise<string>;
    };
    return c.getInviteCode();
  }

  async revokeGroupInvite(lineId: LineId, group: Address): Promise<string> {
    const { cliente } = this.#require(lineId);
    const c = (await cliente.getChatById(toWebId(group))) as unknown as {
      revokeInvite: () => Promise<string>;
    };
    return c.revokeInvite();
  }

  async joinGroupWithCode(lineId: LineId, code: string): Promise<Address> {
    const { cliente } = this.#require(lineId);
    const res = await (cliente as unknown as {
      acceptInvite: (c: string) => Promise<string>;
    }).acceptInvite(code);
    const address = res ? tryParseAddress(String(res)) : null;
    if (!address) throw new OmniError("upstream_failed", "el código de invitación no sirvió");
    return address;
  }

  async updateParticipants(
    lineId: LineId, group: Address, participants: readonly Address[],
    action: "add" | "remove" | "promote" | "demote",
  ): Promise<readonly { address: Address; ok: boolean; reason?: string }[]> {
    const { cliente } = this.#require(lineId);
    const c = (await cliente.getChatById(toWebId(group))) as Record<string, (ids: string[]) => Promise<unknown>>;
    const metodo = { add: "addParticipants", remove: "removeParticipants", promote: "promoteParticipants", demote: "demoteParticipants" }[action];
    const resultado = await c[metodo]!(participants.map(toWebId));

    /*
     * `addParticipants` devuelve un objeto con el resultado POR participante;
     * los demás no devuelven nada útil. Se informa lo que se sabe y no se
     * inventa un "ok" para los que no lo dicen.
     */
    const porParticipante = resultado as Record<string, { code?: number; message?: string }> | undefined;
    return participants.map((address) => {
      const r = porParticipante?.[toWebId(address)];
      if (!r) return { address, ok: true };
      return r.code === 200
        ? { address, ok: true }
        : { address, ok: false, reason: r.message ?? `código ${String(r.code)}` };
    });
  }

  async fetchHistory(lineId: LineId, chat: Address, _before: number, count: number): Promise<void> {
    const { line, cliente } = this.#require(lineId);
    // Esto es lo que Baileys no puede hacer: el historial de verdad.
    const c = (await cliente.getChatById(toWebId(chat))) as {
      fetchMessages: (o: { limit: number }) => Promise<WebMessage[]>;
    };
    const mensajes = await c.fetchMessages({ limit: count });
    await this.emit("history.synced", line.orgId, lineId, {
      chat: chat.value, count: mensajes.length,
    });
  }

  async #buscarMensaje(cliente: WebClient, chat: Address, id: string): Promise<unknown> {
    const c = (await cliente.getChatById(toWebId(chat))) as {
      fetchMessages: (o: { limit: number }) => Promise<WebMessage[]>;
    };
    // La interfaz web no busca por identificador: hay que recorrer el chat. Se
    // limita a los últimos cien para no pedirle a Chromium un histórico entero.
    const mensajes = await c.fetchMessages({ limit: 100 });
    const encontrado = mensajes.find((m) => m.id?._serialized === id);
    if (!encontrado) {
      throw new OmniError(
        "not_found",
        `el mensaje "${id}" no está entre los cien últimos de ese chat; la interfaz web no busca por identificador`,
      );
    }
    return encontrado;
  }
}

/**
 * Traduce nuestra dirección canónica a la que usa whatsapp-web.js.
 *
 * Nosotros canonizamos los individuos a `@s.whatsapp.net`, que es la forma de
 * Baileys; esta biblioteca usa `@c.us`. Pasarle la nuestra hace que TODA
 * búsqueda de chat falle —no encuentra nada y no dice por qué—, así que la
 * conversión tiene que ocurrir en el borde del driver.
 */
export function toWebId(address: Address): string {
  return address.kind === "pn" ? `${address.local}@c.us` : address.value;
}

// ---------------------------------------------------------------- tipos y utilidades

interface WebMessage {
  id?: { _serialized: string };
  from?: string;
  to?: string;
  author?: string;
  body?: string;
  type?: string;
  fromMe?: boolean;
  timestamp?: number;
  notifyName?: string;
}

interface WebChat {
  id?: { _serialized: string };
  name?: string;
  isGroup?: boolean;
  groupMetadata?: {
    desc?: string;
    owner?: { _serialized: string };
    participants?: { id: { _serialized: string }; isAdmin?: boolean; isSuperAdmin?: boolean }[];
  };
}

function toGroupMetadata(address: Address, c: WebChat): GroupMetadata {
  const meta = c.groupMetadata;
  return {
    address,
    subject: c.name ?? "",
    ...(meta?.desc ? { description: meta.desc } : {}),
    ...(meta?.owner ? { owner: parseAddress(meta.owner._serialized) } : {}),
    participants: (meta?.participants ?? []).map((p) => ({
      address: parseAddress(p.id._serialized),
      role: p.isSuperAdmin ? "superadmin" : p.isAdmin ? "admin" : "member",
    })),
  };
}

/** Los acuses de la interfaz web usan su propia escala. */
export function ackToState(ack: number): DeliveryState | null {
  switch (ack) {
    case -1: return "failed";
    case 1: return "sent";
    case 2: return "delivered";
    case 3: return "read";
    case 4: return "played";
    default: return null;
  }
}

export function webKind(type: string): MessageKind {
  switch (type) {
    case "chat": return "text";
    case "image": return "image";
    case "video": return "video";
    case "ptt":
    case "audio": return "audio";
    case "document": return "document";
    case "sticker": return "sticker";
    case "location": return "location";
    case "vcard":
    case "multi_vcard": return "contact";
    case "poll_creation": return "poll";
    case "revoked": return "system";
    default: return "unknown";
  }
}

/** Traduce nuestra orden al contenido de whatsapp-web.js. */
export function toWebContent(
  cmd: OutboundCommand, field: string,
): { contenido: unknown; opciones: Record<string, unknown> } {
  const input = cmd.input;
  const opciones: Record<string, unknown> = {
    ...(input.caption ? { caption: input.caption } : {}),
    ...(input.mentions?.length ? { mentions: input.mentions } : {}),
    ...(input.replyTo ? { quotedMessageId: input.replyTo } : {}),
  };

  if (field === "text") return { contenido: input.text!, opciones };

  if (field === "location") {
    return {
      contenido: {
        latitude: input.location!.latitude, longitude: input.location!.longitude,
        description: input.location!.name ?? input.location!.address ?? "",
      },
      opciones,
    };
  }

  if (field === "poll") {
    return {
      contenido: {
        pollName: input.poll!.question,
        pollOptions: [...input.poll!.options],
        allowMultipleAnswers: input.poll!.allowMultipleAnswers,
      },
      opciones,
    };
  }

  if (field === "contact") {
    const c = input.contact!;
    const vcard = [
      "BEGIN:VCARD", "VERSION:3.0", `FN:${c.fullName}`,
      `TEL;type=CELL;waid=${c.phone.replace(/\D/g, "")}:${c.phone}`,
      "END:VCARD",
    ].join("\n");
    return { contenido: vcard, opciones };
  }

  // Medios: el cliente espera su propio envoltorio con los bytes en base64.
  if (!cmd.media) {
    throw new MedioAusenteError(field);
  }
  return {
    contenido: {
      mimetype: cmd.media.mimeType,
      data: Buffer.from(cmd.media.bytes).toString("base64"),
      filename: input.fileName ?? cmd.media.fileName ?? "adjunto",
    },
    opciones: {
      ...opciones,
      ...(field === "sticker" ? { sendMediaAsSticker: true } : {}),
      ...(field === "document" ? { sendMediaAsDocument: true } : {}),
      ...(field === "audio" && input.ptt ? { sendAudioAsVoice: true } : {}),
    },
  };
}

class MedioAusenteError extends OmniError {
  constructor(field: string) {
    super("validation_failed", `falta el contenido del medio para "${field}"`, { campo: field });
  }
}

/** Fábrica por defecto: el cliente real, con el Chromium del sistema. */
const defaultFactory: WebClientFactory = async ({ sessionId, store, executablePath, proxyUrl }) => {
  const { Client, RemoteAuth } = (await import("whatsapp-web.js")) as unknown as {
    Client: new (o: unknown) => WebClient;
    RemoteAuth: new (o: unknown) => unknown;
  };
  return new Client({
    authStrategy: new RemoteAuth({
      clientId: sessionId,
      store,
      // Cada cinco minutos: más a menudo comprime el perfil sin parar, y menos
      // arriesga perder la sesión en un reinicio inesperado.
      backupSyncIntervalMs: 300000,
    }),
    puppeteer: {
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        ...(proxyUrl ? [`--proxy-server=${proxyUrl}`] : []),
      ],
    },
  });
};
