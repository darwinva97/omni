import { createHash } from "node:crypto";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  type Contact as Contacto,
  Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion,
  normalizeMessageContent,
  type WAMessage, type WASocket,
} from "baileys";
import {
  capabilitySet, OmniError, parseAddress, tryParseAddress,
  type Address, type ChannelDescriptor, type DeliveryState, type LineId, type MessageKind,
} from "@omni/shared";
import {
  EventEmitterBase,
  type ChannelDriver, type ConnectRequest, type ConnectResult,
  type ChatAnchorMessage, type Collection, type CommunityMetadata, type ContactProfile,
  type DownloadedMedia, type ForwardSource, type GroupMetadata, type GroupPatch,
  type LineStatus, type NewsletterMetadata, type OrderDetails, type Product, type ProductInput, type OutboundCommand, type SendReceipt,
} from "../port.js";
import { BlobAuthStore } from "./auth-store.js";
import { toBaileysContent } from "./content.js";

/**
 * Driver de WhatsApp sobre Baileys.
 *
 * Conduce un cliente NO OFICIAL: habla el protocolo multidispositivo
 * directamente. Es el más ligero —decenas de megas por línea frente a los
 * cientos de un navegador headless— y el más fácil de identificar para
 * WhatsApp. Quien lo use debe asumir que la cuenta puede ser restringida.
 */

export const BAILEYS_DESCRIPTOR: ChannelDescriptor = {
  kind: "whatsapp.baileys",
  network: "whatsapp",
  linkMethod: "qr",
  risk: "unofficial",
  approxMemoryMbPerLine: 60,
  capabilities: capabilitySet(
    "send.text", "send.image", "send.video", "send.audio", "send.document",
    "send.sticker", "send.location", "send.contact", "send.poll", "send.reaction",
    "send.reply", "send.mentions", "send.viewOnce", "send.forward",
    "message.edit", "message.delete", "message.receipts",
    "chat.read", "chat.presence", "chat.typing", "chat.archive", "chat.mute", "chat.ephemeral",
    "group.read", "group.create", "group.manage", "group.invite", "group.participants",
    "chat.clear", "chat.delete",
    "contact.check", "contact.block", "contact.profile", "identity.lid",
    "call.receive", "call.reject",
    "community.read", "community.manage",
    "catalog.read", "catalog.manage",
    "newsletter.read", "newsletter.send", "history.sync", "media.decrypt",
    // Deliberadamente AUSENTES: `send.buttons` y `send.list` necesitan un fork,
    // y `label.manage` no lo expone el protocolo de forma estable. Declararlas
    // haría que la API aceptara peticiones que luego no llegan a ninguna parte.
  ),
};

interface LineRuntime {
  socket: WASocket | null;
  status: LineStatus;
  readonly orgId: string;
  readonly store: BlobAuthStore;
  readonly save: (b: Uint8Array) => Promise<void>;
  /** Reintentos de reconexión consumidos, para el retardo creciente. */
  attempts: number;
  closing: boolean;
  /**
   * Lo enviado, por identificador de mensaje.
   *
   * Cuando un dispositivo del destinatario no consigue descifrar un mensaje
   * —pasa, y más con el cambio a direccionamiento por LID— pide un REINTENTO,
   * y WhatsApp nos lo reclama por `getMessage`. Si no lo tenemos, ese
   * dispositivo no lo recibe nunca y el mensaje no aparece en él, sin ningún
   * error por nuestra parte. Eso es lo que devolvía `undefined` siempre.
   */
  readonly enviados: Map<string, unknown>;
  /**
   * Del identificador del proveedor al que puso el cliente.
   *
   * WhatsApp devuelve el suyo y lo que vuelve por los eventos lleva solo ese,
   * así que sin este puente quien envió un mensaje no puede reconocerlo cuando
   * le vuelve: el panel se quedaba con el mensaje en «queued» para siempre
   * porque los acuses hablaban de un identificador que él no conocía.
   */
  readonly porProveedor: Map<string, string>;
  /**
   * Envíos recientes por `clientMessageId`.
   *
   * La cola ya evita encolar dos veces, pero un trabajo SÍ se reintenta: si el
   * primer intento llegó a WhatsApp y falló al anotarse, el reintento mandaría
   * el mensaje otra vez. Esto lo corta dentro del proceso.
   */
  readonly recent: Map<string, SendReceipt>;
}

export type SocketFactory = (opts: Parameters<typeof makeWASocket>[0]) => WASocket;

/** Lo mínimo del registro que espera Baileys. */
export interface RegistroBaileys {
  level: string;
  trace(...a: unknown[]): void;
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
  fatal?(...a: unknown[]): void;
  child(ligaduras?: unknown): RegistroBaileys;
}

export interface BaileysOptions {
  /**
   * Registro que se le pasa a Baileys.
   *
   * Sin poder subirlo a `debug` no hay forma de ver el diálogo con el servidor
   * de WhatsApp, y hay fallos —un mensaje que el servidor acepta y ningún
   * cliente muestra— que solo se ven ahí.
   */
  readonly logger?: RegistroBaileys;
  /** Permite inyectar un socket falso en las pruebas. */
  readonly makeSocket?: SocketFactory;
  readonly fetchVersion?: typeof fetchLatestBaileysVersion;
  /** Retardo base entre reintentos de reconexión, en ms. */
  readonly reconnectBaseMs?: number;
  readonly maxReconnectAttempts?: number;
  /**
   * Cuánto espera `connect` a que llegue el QR antes de devolver.
   * Bajarlo a 0 hace que vuelva enseguida y haya que sondear el estado.
   */
  readonly linkWaitMs?: number;
}

export class BaileysDriver extends EventEmitterBase implements ChannelDriver {
  readonly descriptor = BAILEYS_DESCRIPTOR;
  readonly #lines = new Map<string, LineRuntime>();
  readonly #make: SocketFactory;
  readonly #fetchVersion: typeof fetchLatestBaileysVersion;
  readonly #reconnectBaseMs: number;
  readonly #maxAttempts: number;
  readonly #linkWaitMs: number;
  readonly #logger: RegistroBaileys | null;

  constructor(opts: BaileysOptions = {}) {
    super();
    this.#make = opts.makeSocket ?? ((o) => makeWASocket(o));
    this.#fetchVersion = opts.fetchVersion ?? fetchLatestBaileysVersion;
    this.#reconnectBaseMs = opts.reconnectBaseMs ?? 2000;
    this.#maxAttempts = opts.maxReconnectAttempts ?? 5;
    this.#linkWaitMs = opts.linkWaitMs ?? 8000;
    this.#logger = opts.logger ?? null;
  }

  // ---------------------------------------------------------------- conexión

  async connect(req: ConnectRequest): Promise<ConnectResult> {
    const orgId = String(req.config["orgId"] ?? "");
    const existente = this.#lines.get(req.lineId);
    if (existente?.status.state === "connected") return { status: existente.status };

    const store = BlobAuthStore.from(req.credentials, () => {
      void req.saveCredentials(store.serialize());
    });

    const line: LineRuntime = {
      socket: null,
      status: { state: "connecting" },
      orgId,
      store,
      save: req.saveCredentials,
      attempts: 0,
      closing: false,
      recent: new Map(),
      enviados: new Map(),
      porProveedor: new Map(),
    };
    this.#lines.set(req.lineId, line);

    await this.#open(req.lineId, line, req.config);

    /*
     * Se espera un momento a que llegue el QR (o a que abra con credenciales
     * guardadas). El QR tarda un instante en llegar desde WhatsApp, y devolver
     * "connecting" obliga a quien llama a hacer sondeo para algo que casi
     * siempre está listo en menos de un segundo.
     */
    await this.#awaitLinkable(line, this.#linkWaitMs);
    return { status: line.status };
  }

  async #awaitLinkable(line: LineRuntime, timeoutMs: number): Promise<void> {
    const limite = Date.now() + timeoutMs;
    while (Date.now() < limite) {
      if (line.status.state !== "connecting") return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async #open(lineId: string, line: LineRuntime, config: Readonly<Record<string, unknown>>): Promise<void> {
    const { version } = await this.#fetchVersion().catch(() => ({ version: undefined }));

    const socket = this.#make({
      ...(version ? { version } : {}),
      auth: line.store.state(),
      // Se desactiva el QR en el terminal: aquí el QR viaja por evento hacia el
      // panel, y escribirlo en los registros lo dejaría en texto plano.
      printQRInTerminal: false,
      browser: Browsers.appropriate("Chrome"),
      syncFullHistory: config["syncFullHistory"] === true,
      markOnlineOnConnect: false,
      ...(this.#logger ? { logger: this.#logger } : {}),
      ...(config["proxyUrl"] ? { agent: undefined } : {}),
      /*
       * Sirve el reintento que pide un dispositivo que no pudo descifrar.
       *
       * Devolver `undefined` —lo que hacía antes— significa «no lo tengo»: el
       * dispositivo se queda sin el mensaje y nadie se entera.
       */
      getMessage: async (key) =>
        (line.enviados.get(String(key.id ?? "")) ?? undefined) as never,
    } as Parameters<typeof makeWASocket>[0]);

    line.socket = socket;
    this.#wire(lineId, line, socket, config);
  }

  #wire(
    lineId: string,
    line: LineRuntime,
    socket: WASocket,
    config: Readonly<Record<string, unknown>>,
  ): void {
    const ev = socket.ev;

    ev.on("creds.update", () => {
      line.store.markCredsUpdated(socket.authState.creds);
    });

    ev.on("connection.update", (update) => {
      void this.#onConnectionUpdate(lineId, line, socket, config, update);
    });

    ev.on("messages.upsert", ({ messages, type }) => {
      /*
       * Dos tipos, y hacen falta los dos.
       *
       * `notify` son los mensajes nuevos que llegan de fuera. Lo que uno
       * escribe desde OTRO dispositivo de la misma cuenta —el teléfono, con el
       * panel abierto— llega como `append`, porque para el servidor no es una
       * notificación: es un mensaje que se añade a una conversación que ya
       * tienes. Descartarlo dejaba el panel sin la mitad de la conversación.
       *
       * De `append` solo se acepta lo PROPIO. Ese tipo también lo usa WhatsApp
       * para rellenar huecos de historial, y tragarlo entero reingeriría
       * conversaciones viejas como si acabaran de llegar, subiéndolas en la
       * lista y marcándolas sin leer.
       */
      for (const m of messages) {
        if (type !== "notify" && !m.key.fromMe) continue;
        void this.#onMessage(lineId, line, m);
      }
    });

    ev.on("messages.update", (updates) => {
      for (const u of updates) {
        const estado = ackToState(u.update.status);
        if (estado) {
          void this.emit("message.receipt", line.orgId, lineId, {
            key: normalizeKey(u.key), state: estado,
          });
        }
        const editado = u.update.message?.editedMessage;
        if (editado) {
          void this.emit("message.updated", line.orgId, lineId, {
            key: normalizeKey(u.key),
            text: extractText(u.update.message ?? null),
          });
        }
      }
    });

    ev.on("message-receipt.update", (updates) => {
      for (const u of updates) {
        const estado: DeliveryState = u.receipt.readTimestamp ? "read" : "delivered";
        const propio = u.key.id ? line.porProveedor.get(u.key.id) : undefined;
        void this.emit("message.receipt", line.orgId, lineId, {
          key: normalizeKey(u.key), state: estado, participant: u.receipt.userJid,
          ...(propio ? { clientMessageId: propio } : {}),
        });
      }
    });

    ev.on("messages.reaction", (reactions) => {
      for (const r of reactions) {
        void this.emit("message.reaction", line.orgId, lineId, {
          key: normalizeKey(r.key), emoji: r.reaction.text ?? "",
        });
      }
    });

    ev.on("messages.delete", (item) => {
      const keys = "keys" in item ? item.keys : [];
      for (const k of keys) {
        void this.emit("message.deleted", line.orgId, lineId, { key: normalizeKey(k) });
      }
    });

    ev.on("groups.update", (updates) => {
      for (const g of updates) {
        void this.emit("group.updated", line.orgId, lineId, { group: g.id, subject: g.subject });
      }
    });

    ev.on("group-participants.update", (update) => {
      void this.emit("group.participants", line.orgId, lineId, {
        group: update.id, action: update.action, participants: update.participants,
      });
    });

    /*
     * Los contactos llegan por DOS eventos y hacen falta los dos.
     *
     * `contacts.upsert` es el volcado inicial de la agenda al enlazar —de ahí
     * salen casi todos los nombres guardados— y `contacts.update` son los
     * cambios posteriores. Escuchando solo el segundo, una cuenta recién
     * enlazada se queda sin un solo nombre de agenda hasta que alguien se
     * renombre.
     */
    const anotarContactos = (contacts: readonly Partial<Contacto>[]): void => {
      for (const c of contacts) {
        if (!c.id) continue;
        void this.emit("contact.updated", line.orgId, lineId, {
          address: c.id,
          // `name` es el que TÚ le pusiste en tu agenda; `notify` el que esa
          // persona se puso a sí misma. Son dos datos distintos y los dos
          // valen: el tuyo manda al enseñarlo, el suyo es el recambio.
          savedName: c.name ?? c.verifiedName ?? null,
          pushName: c.notify ?? null,
          ...(c.imgUrl !== undefined ? { imgUrl: c.imgUrl } : {}),
        });
      }
    };

    ev.on("contacts.upsert", anotarContactos);
    ev.on("contacts.update", anotarContactos);
    /*
     * Y el volcado del historial, que es de donde sale la AGENDA.
     *
     * Los nombres que uno guarda no viajan en los mensajes ni en la
     * sincronización de estado: llegan aquí, con el volcado inicial. Sin
     * escuchar esto, una cuenta puede tener ciento sesenta contactos conocidos
     * y ni un solo nombre de los que su dueño les puso.
     */
    ev.on("messaging-history.set", ({ contacts }) => {
      if (contacts?.length) anotarContactos(contacts);
    });

    ev.on("chats.update", (chats) => {
      for (const c of chats) {
        void this.emit("chat.updated", line.orgId, lineId, {
          chat: c.id, unreadCount: c.unreadCount ?? null, archived: c.archived ?? null,
        });
      }
    });

    ev.on("presence.update", ({ id, presences }) => {
      void this.emit("presence.updated", line.orgId, lineId, { chat: id, presences });
    });

    ev.on("call", (calls) => {
      for (const c of calls) {
        void this.emit("call.received", line.orgId, lineId, {
          callId: c.id, from: c.from, isVideo: c.isVideo ?? false, status: c.status,
        });
      }
    });
  }

  async #onConnectionUpdate(
    lineId: string,
    line: LineRuntime,
    socket: WASocket,
    config: Readonly<Record<string, unknown>>,
    update: { connection?: string; lastDisconnect?: { error?: Error }; qr?: string },
  ): Promise<void> {
    if (update.qr) {
      line.status = { state: "awaiting-link", qr: update.qr };
      await this.emit("session.qr", line.orgId, lineId, { qr: update.qr });
      await this.emit("session.status", line.orgId, lineId, { state: "awaiting-link" });
    }

    if (update.connection === "open") {
      line.attempts = 0;
      const self = tryParseAddress(socket.user?.id ?? "") ?? parseAddress("0@s.whatsapp.net");
      line.status = {
        state: "connected", self,
        ...(socket.user?.name ? { pushName: socket.user.name } : {}),
      };
      await this.emit("session.connected", line.orgId, lineId, { self: self.value });
      await this.emit("session.status", line.orgId, lineId, { state: "connected" });
    }

    if (update.connection === "close") {
      const code = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;

      /*
       * Distinguir "se cayó" de "nos han desvinculado" es lo más importante
       * de este bloque. Ante `loggedOut`, reconectar es inútil y además
       * insistente: las credenciales ya no valen y hay que volver a escanear.
       */
      if (code === DisconnectReason.loggedOut) {
        line.status = { state: "logged-out", reason: "el dispositivo fue desvinculado" };
        await this.emit("session.logged_out", line.orgId, lineId, { code });
        await this.emit("session.status", line.orgId, lineId, { state: "logged-out" });
        return;
      }

      if (line.closing) {
        line.status = { state: "disconnected" };
        return;
      }

      line.status = { state: "disconnected" };
      await this.emit("session.disconnected", line.orgId, lineId, {
        code: code ?? null, reason: update.lastDisconnect?.error?.message ?? "desconocido",
      });

      if (line.attempts >= this.#maxAttempts) {
        await this.emit("session.error", line.orgId, lineId, {
          reason: `no se pudo reconectar tras ${line.attempts} intentos`,
        });
        return;
      }

      // Retardo creciente: reconectar en bucle cerrado es una señal clarísima
      // de automatización y acelera la restricción de la cuenta.
      const espera = this.#reconnectBaseMs * 2 ** line.attempts;
      line.attempts++;
      setTimeout(() => {
        if (!line.closing) void this.#open(lineId, line, config).catch(() => {});
      }, espera);
    }
  }

  async #onMessage(lineId: string, line: LineRuntime, m: WAMessage): Promise<void> {
    if (!m.key.remoteJid) return;
    /*
     * Un sobre sin contenido no es un mensaje.
     *
     * WhatsApp manda nodos que solo llevan datos de cifrado o de contexto. No
     * ha pasado nada que contar, y publicarlos llenaba el hilo de avisos de
     * «mensaje no compatible»: eran la mitad de los que salían así.
     */
    if (esVacio(m)) return;
    const clientMessageId = m.key.id ? line.porProveedor.get(m.key.id) : undefined;
    const payload = {
      key: normalizeKey(m.key),
      pushName: m.pushName ?? null,
      kind: messageKind(m),
      text: extractText(m.message ?? null),
      timestamp: Number(m.messageTimestamp ?? 0) * 1000,
      // Solo cuando el envío salió de aquí; de lo ajeno no hay ninguno.
      ...(clientMessageId ? { clientMessageId } : {}),
      raw: m,
    };
    if (!m.key.fromMe) {
      await this.emit("message.received", line.orgId, lineId, payload);
    } else {
      await this.emit("message.sent", line.orgId, lineId, payload);
    }
    await this.emit("message.upsert", line.orgId, lineId, payload);
  }

  // ---------------------------------------------------------------- estado

  status(lineId: LineId): LineStatus {
    return this.#lines.get(lineId)?.status ?? { state: "disconnected" };
  }

  async disconnect(lineId: LineId): Promise<void> {
    const line = this.#lines.get(lineId);
    if (!line) return;
    line.closing = true;
    try {
      line.socket?.end(undefined);
    } catch { /* ya estaba cerrado */ }
    line.status = { state: "disconnected" };
    await this.emit("session.disconnected", line.orgId, lineId, { reason: "requested" });
  }

  #require(lineId: string): { line: LineRuntime; socket: WASocket } {
    const line = this.#lines.get(lineId);
    if (!line) throw new OmniError("not_found", `la línea "${lineId}" no está registrada`);
    if (line.status.state !== "connected" || !line.socket) {
      throw new OmniError("line_not_connected", `la línea "${lineId}" no está conectada (${line.status.state})`);
    }
    return { line, socket: line.socket };
  }

  // ---------------------------------------------------------------- envío

  async send(cmd: OutboundCommand): Promise<SendReceipt> {
    const { line, socket } = this.#require(cmd.lineId);

    const yaEnviado = line.recent.get(cmd.clientMessageId);
    if (yaEnviado) return yaEnviado;

    const content = toBaileysContent(cmd);

    if (cmd.input.typingMs && cmd.input.typingMs > 0) {
      await socket.sendPresenceUpdate("composing", cmd.to.value).catch(() => {});
      await new Promise((r) => setTimeout(r, Math.min(cmd.input.typingMs!, 30000)));
      await socket.sendPresenceUpdate("paused", cmd.to.value).catch(() => {});
    }

    const quoted = cmd.input.replyTo
      ? { quoted: { key: { id: cmd.input.replyTo, remoteJid: cmd.to.value, fromMe: false }, message: {} } }
      : {};

    /*
     * El identificador del mensaje se DERIVA del `clientMessageId`.
     *
     * Así dos envíos de la misma orden llevan el mismo identificador, y el
     * cliente de WhatsApp del destinatario —que deduplica por identificador—
     * enseña un solo mensaje aunque nosotros lo mandáramos dos veces. Es la
     * segunda red de seguridad, por debajo del mapa de arriba.
     */
    const messageId = deterministicMessageId(cmd.clientMessageId);

    const sent = await socket.sendMessage(cmd.to.value, content, {
      ...quoted, messageId,
    } as never);
    if (!sent?.key.id) {
      throw new OmniError("upstream_failed", "WhatsApp no devolvió identificador para el mensaje");
    }
    /*
     * Se guarda el mensaje tal cual se construyó, para poder servir un
     * reintento. Acotado: son mensajes enteros en memoria, y lo que se
     * reintenta se reintenta en los primeros minutos, no días después.
     */
    line.porProveedor.set(sent.key.id, cmd.clientMessageId);
    if (line.porProveedor.size > 2000) {
      const vieja = line.porProveedor.keys().next().value;
      if (vieja !== undefined) line.porProveedor.delete(vieja);
    }

    if (sent.message) {
      line.enviados.set(sent.key.id, sent.message);
      if (line.enviados.size > 500) {
        const primera = line.enviados.keys().next().value;
        if (primera !== undefined) line.enviados.delete(primera);
      }
    }

    const receipt: SendReceipt = {
      providerMessageId: sent.key.id,
      state: "sent",
      timestamp: Number(sent.messageTimestamp ?? 0) * 1000 || Date.now(),
    };

    line.recent.set(cmd.clientMessageId, receipt);
    // El mapa está acotado: una línea muy activa no puede crecer sin límite.
    if (line.recent.size > 2000) {
      const primera = line.recent.keys().next().value;
      if (primera !== undefined) line.recent.delete(primera);
    }
    return receipt;
  }

  // ---------------------------------------------------------------- opcionales

  async editMessage(lineId: LineId, chat: Address, providerMessageId: string, text: string): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.sendMessage(chat.value, {
      text,
      edit: { id: providerMessageId, remoteJid: chat.value, fromMe: true },
    } as never);
  }

  async deleteMessage(lineId: LineId, chat: Address, providerMessageId: string): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.sendMessage(chat.value, {
      delete: { id: providerMessageId, remoteJid: chat.value, fromMe: true },
    });
  }

  async react(lineId: LineId, chat: Address, providerMessageId: string, emoji: string): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.sendMessage(chat.value, {
      // Cadena vacía = retirar la reacción. Es como lo expresa el protocolo.
      react: { text: emoji, key: { id: providerMessageId, remoteJid: chat.value, fromMe: false } },
    });
  }

  async markRead(lineId: LineId, chat: Address, ids: readonly string[]): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.readMessages(ids.map((id) => ({ id, remoteJid: chat.value, fromMe: false })));
  }

  async setPresence(
    lineId: LineId, chat: Address, presence: "composing" | "recording" | "paused",
  ): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.sendPresenceUpdate(presence, chat.value);
  }

  async checkContact(lineId: LineId, address: Address): Promise<{ exists: boolean; address: Address | null }> {
    const { socket } = this.#require(lineId);
    const res = await socket.onWhatsApp(address.local);
    const hit = res?.[0];
    return hit?.exists
      ? { exists: true, address: tryParseAddress(String(hit.jid)) }
      : { exists: false, address: null };
  }

  async groupMetadata(lineId: LineId, group: Address): Promise<GroupMetadata> {
    const { socket } = this.#require(lineId);
    const meta = await socket.groupMetadata(group.value);
    return toGroupMetadata(meta);
  }

  async listGroups(lineId: LineId): Promise<readonly GroupMetadata[]> {
    const { socket } = this.#require(lineId);
    const all = await socket.groupFetchAllParticipating();
    return Object.values(all).map(toGroupMetadata);
  }

  async createGroup(
    lineId: LineId, subject: string, participants: readonly Address[],
  ): Promise<GroupMetadata> {
    const { socket } = this.#require(lineId);
    const meta = await socket.groupCreate(subject, participants.map((p) => p.value));
    return toGroupMetadata(meta);
  }

  async updateGroup(lineId: LineId, group: Address, patch: GroupPatch): Promise<void> {
    const { socket } = this.#require(lineId);
    if (patch.subject !== undefined) await socket.groupUpdateSubject(group.value, patch.subject);
    if (patch.description !== undefined) {
      await socket.groupUpdateDescription(group.value, patch.description);
    }
  }

  async leaveGroup(lineId: LineId, group: Address): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.groupLeave(group.value);
  }

  async groupInviteCode(lineId: LineId, group: Address): Promise<string> {
    const { socket } = this.#require(lineId);
    const code = await socket.groupInviteCode(group.value);
    if (!code) throw new OmniError("upstream_failed", "WhatsApp no devolvió código de invitación");
    return code;
  }

  async revokeGroupInvite(lineId: LineId, group: Address): Promise<string> {
    const { socket } = this.#require(lineId);
    const code = await socket.groupRevokeInvite(group.value);
    if (!code) throw new OmniError("upstream_failed", "WhatsApp no devolvió el código nuevo");
    return code;
  }

  async joinGroupWithCode(lineId: LineId, code: string): Promise<Address> {
    const { socket } = this.#require(lineId);
    const jid = await socket.groupAcceptInvite(code);
    const address = jid ? tryParseAddress(String(jid)) : null;
    if (!address) throw new OmniError("upstream_failed", "el código de invitación no sirvió");
    return address;
  }

  async updateParticipants(
    lineId: LineId, group: Address, participants: readonly Address[],
    action: "add" | "remove" | "promote" | "demote",
  ): Promise<readonly { address: Address; ok: boolean; reason?: string }[]> {
    const { socket } = this.#require(lineId);
    const res = await socket.groupParticipantsUpdate(
      group.value, participants.map((p) => p.value), action,
    );
    return res.map((r) => {
      const address = tryParseAddress(String(r.jid)) ?? participants[0]!;
      // WhatsApp responde POR PARTICIPANTE: unos entran y otros no, en la misma
      // petición. Colapsarlo a un sí o no escondería la mitad del resultado.
      return r.status === "200"
        ? { address, ok: true }
        : { address, ok: false, reason: `WhatsApp respondió ${r.status}` };
    });
  }

  async clearChat(
    lineId: LineId, chat: Address, anchor: readonly ChatAnchorMessage[],
  ): Promise<void> {
    const { socket } = this.#require(lineId);
    if (anchor.length === 0) {
      throw new OmniError(
        "validation_failed",
        "no hay ningún mensaje conocido en esa conversación desde el que vaciar",
      );
    }
    await socket.chatModify(
      { clear: true, lastMessages: anclaBaileys(chat, anchor) },
      chat.value,
    );
  }

  async archiveChat(
    lineId: LineId, chat: Address, archivar: boolean, anchor: readonly ChatAnchorMessage[],
  ): Promise<void> {
    const { socket } = this.#require(lineId);
    // Archivar pide el mismo ancla que vaciar: WhatsApp necesita saber hasta
    // qué punto del historial se está actuando.
    await socket.chatModify({ archive: archivar, lastMessages: anclaBaileys(chat, anchor) }, chat.value);
  }

  async muteChat(lineId: LineId, chat: Address, hasta: number | null): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.chatModify({ mute: hasta }, chat.value);
  }

  async setEphemeral(lineId: LineId, chat: Address, segundos: number): Promise<void> {
    const { socket } = this.#require(lineId);
    /*
     * WhatsApp solo admite estos valores. Mandar otro NO falla: se ignora en
     * silencio y el usuario cree que ha puesto sus mensajes a caducar en una
     * hora cuando siguen ahí para siempre.
     */
    const PERMITIDOS = [0, 86400, 604800, 7776000];
    if (!PERMITIDOS.includes(segundos)) {
      throw new OmniError(
        "validation_failed",
        `WhatsApp solo admite ${PERMITIDOS.join(", ")} segundos; "${segundos}" se ignoraría en silencio`,
      );
    }
    if (chat.kind === "group") {
      await socket.groupToggleEphemeral(chat.value, segundos);
      return;
    }
    await socket.sendMessage(chat.value, { disappearingMessagesInChat: segundos });
  }

  async blockContact(lineId: LineId, address: Address, bloquear: boolean): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.updateBlockStatus(address.value, bloquear ? "block" : "unblock");
  }

  async resyncContacts(lineId: LineId): Promise<void> {
    const { socket } = this.#require(lineId);
    /*
     * `critical_unblock_low` es la colección donde WhatsApp guarda la agenda.
     * El `false` dice que NO es la sincronización inicial: pedirla como
     * inicial haría bajar el historial entero otra vez.
     */
    await socket.resyncAppState(["critical_unblock_low"], false);
  }

  async profilePictureUrl(lineId: LineId, address: Address): Promise<string | null> {
    const { socket } = this.#require(lineId);
    // Quien tiene la foto oculta devuelve un error, no un hueco: eso no es un
    // fallo del sistema, es una respuesta.
    return (await socket.profilePictureUrl(address.value, "image").catch(() => undefined)) ?? null;
  }

  async contactProfile(lineId: LineId, address: Address): Promise<ContactProfile> {
    const { socket } = this.#require(lineId);
    /*
     * Cada dato viene de una llamada distinta y cualquiera puede fallar sola:
     * quien tiene la foto oculta devuelve un error, no un hueco. Un fallo en
     * una parte no puede dejar sin las otras.
     */
    const [foto, estado, negocio] = await Promise.all([
      socket.profilePictureUrl(address.value, "image").catch(() => undefined),
      socket.fetchStatus(address.value).catch(() => undefined),
      socket.getBusinessProfile(address.value).catch(() => undefined),
    ]);
    const about = Array.isArray(estado)
      ? (estado[0] as { status?: { status?: string } } | undefined)?.status?.status
      : undefined;
    return {
      address,
      ...(foto ? { pictureUrl: foto } : {}),
      ...(about ? { about } : {}),
      isBusiness: Boolean(negocio),
    };
  }

  async forwardMessage(
    lineId: LineId, origen: ForwardSource, hacia: Address,
  ): Promise<SendReceipt> {
    const { socket } = this.#require(lineId);
    /*
     * Baileys reenvía el MENSAJE entero, no su identificador: necesita el
     * objeto original tal cual llegó. Lo guardamos en `message.raw` de los
     * entrantes, y quien llama nos lo pasa. De los que enviamos nosotros no
     * guardamos ese objeto, así que ahí se dice que no en vez de reenviar algo
     * distinto de lo que se pidió.
     */
    if (!origen.raw) {
      throw new OmniError(
        "validation_failed",
        `no conservamos el mensaje original de "${origen.providerMessageId}", y este transporte lo necesita entero para reenviarlo`,
      );
    }
    const enviado = await socket.sendMessage(hacia.value, { forward: origen.raw as never });
    return {
      providerMessageId: String(enviado?.key?.id ?? origen.providerMessageId),
      state: "sent",
      timestamp: Date.now(),
    };
  }

  async downloadMedia(lineId: LineId, raw: unknown): Promise<DownloadedMedia | null> {
    const { socket } = this.#require(lineId);
    const mensaje = raw as WAMessage | { raw?: WAMessage } | null;
    // La ingesta guarda el sobre entero; el mensaje de Baileys va dentro.
    const m = (mensaje && "raw" in mensaje ? mensaje.raw : mensaje) as WAMessage | null;
    if (!m?.message) return null;

    const tipo = messageKind(m);
    if (!["image", "video", "audio", "document", "sticker"].includes(tipo)) return null;

    /*
     * `reuploadRequest` es lo que salva los medios viejos: si el servidor ya
     * no tiene el fichero, Baileys pide al remitente que lo vuelva a subir.
     * Sin eso, cualquier medio de hace unos días se descarga con un 404.
     */
    const bytes = await downloadMediaMessage(m, "buffer", {}, {
      // Baileys escribe por aquí; sin un registro mudo saca ruido por consola
      // en cada medio que llega.
      logger: REGISTRO_MUDO,
      reuploadRequest: socket.updateMediaMessage,
    });

    const contenido = m.message;
    const info =
      contenido.imageMessage ?? contenido.videoMessage ?? contenido.audioMessage ??
      contenido.documentMessage ?? contenido.stickerMessage;
    return {
      bytes: new Uint8Array(bytes),
      mimeType: info?.mimetype ?? "application/octet-stream",
      ...(contenido.documentMessage?.fileName
        ? { fileName: contenido.documentMessage.fileName }
        : {}),
    };
  }

  // ---------------------------------------------------------------- comunidades

  async communityMetadata(lineId: LineId, community: Address): Promise<CommunityMetadata> {
    const { socket } = this.#require(lineId);
    const [meta, enlazados] = await Promise.all([
      socket.communityMetadata(community.value),
      socket.communityFetchLinkedGroups(community.value).catch(() => null),
    ]);
    return toCommunityMetadata(meta, enlazados?.linkedGroups ?? []);
  }

  async listCommunities(lineId: LineId): Promise<readonly CommunityMetadata[]> {
    const { socket } = this.#require(lineId);
    const todas = await socket.communityFetchAllParticipating();
    /*
     * Los grupos enlazados se piden por comunidad, no vienen en el listado.
     * Se traen en paralelo y un fallo en una no deja sin el resto: en una
     * cuenta con veinte comunidades, una sola con problemas se llevaría por
     * delante la lista entera.
     */
    return Promise.all(
      Object.values(todas).map(async (meta) => {
        const enlazados = await socket
          .communityFetchLinkedGroups(String(meta.id))
          .catch(() => null);
        return toCommunityMetadata(meta, enlazados?.linkedGroups ?? []);
      }),
    );
  }

  async createCommunity(
    lineId: LineId, subject: string, description: string,
  ): Promise<CommunityMetadata> {
    const { socket } = this.#require(lineId);
    const meta = await socket.communityCreate(subject, description);
    if (!meta) throw new OmniError("upstream_failed", "WhatsApp no devolvió la comunidad creada");
    return toCommunityMetadata(meta, []);
  }

  async linkGroupToCommunity(lineId: LineId, group: Address, community: Address): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.communityLinkGroup(group.value, community.value);
  }

  async unlinkGroupFromCommunity(lineId: LineId, group: Address, community: Address): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.communityUnlinkGroup(group.value, community.value);
  }

  async leaveCommunity(lineId: LineId, community: Address): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.communityLeave(community.value);
  }

  // ---------------------------------------------------------------- catálogo

  async listProducts(lineId: LineId, de: Address | null, limite: number): Promise<readonly Product[]> {
    const { socket, line } = this.#requireConSelf(lineId);
    const jid = de?.value ?? line;
    const res = await socket.getCatalog({ jid, limit: limite });
    return (res.products ?? []).map(toProduct);
  }

  async listCollections(lineId: LineId, de: Address | null, limite: number): Promise<readonly Collection[]> {
    const { socket, line } = this.#requireConSelf(lineId);
    const res = await socket.getCollections(de?.value ?? line, limite);
    return (res.collections ?? []).map((c) => ({
      id: String(c.id), name: c.name,
      products: (c.products ?? []).map(toProduct),
      ...(c.status?.status ? { status: c.status.status } : {}),
    }));
  }

  async createProduct(lineId: LineId, input: ProductInput): Promise<Product> {
    const { socket } = this.#require(lineId);
    const creado = await socket.productCreate({
      name: input.name, description: input.description,
      price: input.price, currency: input.currency,
      ...(input.retailerId ? { retailerId: input.retailerId } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.hidden !== undefined ? { isHidden: input.hidden } : {}),
      originCountryCode: input.originCountryCode,
      images: input.imageUrls.map((url) => ({ url: new URL(url) })),
    });
    return toProduct(creado);
  }

  async updateProduct(lineId: LineId, productId: string, input: ProductInput): Promise<Product> {
    const { socket } = this.#require(lineId);
    const actualizado = await socket.productUpdate(productId, {
      name: input.name, description: input.description,
      price: input.price, currency: input.currency,
      ...(input.retailerId ? { retailerId: input.retailerId } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.hidden !== undefined ? { isHidden: input.hidden } : {}),
      images: input.imageUrls.map((url) => ({ url: new URL(url) })),
    });
    return toProduct(actualizado);
  }

  async deleteProducts(lineId: LineId, productIds: readonly string[]): Promise<number> {
    const { socket } = this.#require(lineId);
    const res = await socket.productDelete([...productIds]);
    return res.deleted ?? 0;
  }

  async orderDetails(lineId: LineId, orderId: string, token: string): Promise<OrderDetails> {
    const { socket } = this.#require(lineId);
    /*
     * El testigo viene DENTRO del mensaje del pedido y es de un solo uso: sin
     * él no hay forma de leer un pedido, ni siquiera siendo su destinatario.
     */
    const pedido = await socket.getOrderDetails(orderId, token);
    return {
      currency: pedido.price?.currency ?? "",
      total: pedido.price?.total ?? 0,
      products: (pedido.products ?? []).map((p) => ({
        id: String(p.id), name: p.name, quantity: p.quantity,
        price: p.price, currency: p.currency,
        ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
      })),
    };
  }

  /** Como `#require`, y además la dirección propia: el catálogo por defecto es el nuestro. */
  #requireConSelf(lineId: string): { socket: WASocket; line: string } {
    const runtime = this.#require(lineId);
    const estado = this.status(lineId as LineId);
    if (estado.state !== "connected") {
      throw new OmniError("line_not_connected", `la línea "${lineId}" no está conectada`);
    }
    return { socket: runtime.socket, line: estado.self.value };
  }

  async createNewsletter(
    lineId: LineId, name: string, description?: string,
  ): Promise<NewsletterMetadata> {
    const { socket } = this.#require(lineId);
    const meta = await socket.newsletterCreate(name, description);
    return toNewsletterMetadata(meta);
  }

  async deleteChat(
    lineId: LineId, chat: Address, anchor: readonly ChatAnchorMessage[],
  ): Promise<void> {
    const { socket } = this.#require(lineId);
    if (anchor.length === 0) {
      throw new OmniError(
        "validation_failed",
        "no hay ningún mensaje conocido en esa conversación desde el que borrarla",
      );
    }
    await socket.chatModify({ delete: true, lastMessages: anclaBaileys(chat, anchor) }, chat.value);
  }

  async newsletterMetadata(lineId: LineId, newsletter: Address): Promise<NewsletterMetadata> {
    const { socket } = this.#require(lineId);
    const meta = await socket.newsletterMetadata("jid", newsletter.value);
    if (!meta) throw new OmniError("not_found", `el canal "${newsletter.value}" no existe`);
    return toNewsletterMetadata(meta);
  }

  async newsletterByInvite(lineId: LineId, code: string): Promise<NewsletterMetadata> {
    const { socket } = this.#require(lineId);
    const meta = await socket.newsletterMetadata("invite", code);
    if (!meta) throw new OmniError("not_found", "ese enlace de canal no lleva a ninguna parte");
    return toNewsletterMetadata(meta);
  }

  async followNewsletter(lineId: LineId, newsletter: Address): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.newsletterFollow(newsletter.value);
  }

  async unfollowNewsletter(lineId: LineId, newsletter: Address): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.newsletterUnfollow(newsletter.value);
  }

  async rejectCall(lineId: LineId, callId: string, from: Address): Promise<void> {
    const { socket } = this.#require(lineId);
    await socket.rejectCall(callId, from.value);
  }

  async fetchHistory(lineId: LineId, chat: Address, before: number, count: number): Promise<void> {
    const { socket } = this.#require(lineId);
    const oldest = { id: "", remoteJid: chat.value, fromMe: false };
    await socket.fetchMessageHistory(count, oldest, Math.floor(before / 1000) as never);
  }
}

// ---------------------------------------------------------------- utilidades

/**
 * Identificador de mensaje derivado del `clientMessageId`.
 *
 * WhatsApp usa identificadores hexadecimales en mayúsculas; el prefijo `3EB0`
 * es el que generan los clientes oficiales y mantenerlo evita destacar.
 */
export function deterministicMessageId(clientMessageId: string): string {
  const hash = createHash("sha256").update(clientMessageId).digest("hex").toUpperCase();
  /*
   * `3EB0` + 18 hex, EXACTAMENTE como genera Baileys.
   *
   * La longitud no es un detalle estético. Con 28 hex en vez de 18 el servidor
   * de WhatsApp acepta el nodo, devuelve identificador y hasta manda acuses de
   * lectura, pero NINGÚN cliente —ni el del destinatario ni el teléfono del
   * que envía— muestra el mensaje. Es el peor fallo posible: todo parece
   * correcto por dentro y no llega nada.
   */
  return `3EB0${hash.slice(0, 18)}`;
}

/**
 * Normaliza la clave de un mensaje, CONSERVANDO la dirección alternativa.
 *
 * Baileys 7 direcciona con `@lid` de forma habitual y adjunta el teléfono en
 * `remoteJidAlt`/`participantAlt` cuando WhatsApp lo da. Tirar esos campos
 * —que es lo que se hacía— deja un chat identificado solo por un LID que ya no
 * se puede atar a ninguna persona: el mapeo no se puede reconstruir después,
 * porque esa es la única vez que el servidor lo dice.
 */
function normalizeKey(key: {
  id?: string | null; remoteJid?: string | null; fromMe?: boolean | null;
  participant?: string | null; remoteJidAlt?: string | null; participantAlt?: string | null;
}) {
  return {
    id: key.id ?? "",
    remoteJid: key.remoteJid ?? "",
    fromMe: key.fromMe ?? false,
    ...(key.participant ? { participant: key.participant } : {}),
    ...(key.remoteJidAlt ? { remoteJidAlt: key.remoteJidAlt } : {}),
    ...(key.participantAlt ? { participantAlt: key.participantAlt } : {}),
  };
}

/** Los códigos de acuse de WhatsApp, traducidos a nuestros estados. */
export function ackToState(status: number | null | undefined): DeliveryState | null {
  switch (status) {
    case 1: return "sent";
    case 2: return "delivered";
    case 3: return "read";
    case 4: return "played";
    case 0: return "failed";
    default: return null;
  }
}

/**
 * Extrae el texto de un nodo de mensaje.
 *
 * Un mensaje de texto es `conversation`, pero uno con formato es
 * `extendedTextMessage.text`, y uno con medio lleva el texto en su `caption`.
 * Asumir sólo la primera forma es el fallo más común al integrar con WhatsApp.
 */
/**
 * El contenido real, sin envoltorios.
 *
 * WhatsApp mete el mensaje dentro de otro cuando es efímero, de una sola vez,
 * editado, o un documento con pie. Sin desenvolverlo, un PDF con texto llegaba
 * como «mensaje no compatible» porque arriba solo estaba la caja.
 *
 * Lo desenvuelve Baileys y no nosotros a propósito: la lista de envoltorios
 * crece con cada versión del protocolo —en la instalada ya son nueve— y la
 * nuestra se quedaría atrás en silencio.
 */
function contenido(m: WAMessage): Record<string, unknown> | null {
  const normalizado = normalizeMessageContent(m.message ?? undefined);
  return (normalizado as Record<string, unknown> | undefined) ?? null;
}

/** De dónde sale el texto de un mensaje, por tipo de nodo. */
const CAMPOS_CON_TEXTO = [
  "extendedTextMessage", "imageMessage", "videoMessage", "documentMessage",
  "audioMessage", "ptvMessage",
] as const;

export function extractText(message: object | null | undefined): string | null {
  if (!message) return null;
  const crudo = normalizeMessageContent(message as never) ?? message;
  const m = crudo as Record<string, unknown>;
  if (typeof m["conversation"] === "string") return m["conversation"];

  for (const campo of CAMPOS_CON_TEXTO) {
    const nodo = m[campo] as { text?: string; caption?: string } | undefined;
    const valor = nodo?.text ?? nodo?.caption;
    if (typeof valor === "string" && valor !== "") return valor;
  }

  /*
   * Plantillas y mensajes interactivos: lo que escribió el negocio está varios
   * niveles adentro y en tres sitios distintos según cómo se compuso. Se
   * buscan los tres; sin esto una plantilla —y las manda cualquier empresa—
   * se veía como un mensaje vacío.
   */
  const plantilla = dentro(m, "templateMessage");
  const deLaPlantilla = texto(dentro(plantilla, "interactiveMessageTemplate")?.["body"])
    ?? texto(dentro(plantilla, "hydratedTemplate")?.["hydratedContentText"])
    ?? texto(dentro(plantilla, "hydratedFourRowTemplate")?.["hydratedContentText"]);
  if (deLaPlantilla) return deLaPlantilla;

  for (const campo of ["interactiveMessage", "buttonsMessage", "listMessage"]) {
    const nodo = dentro(m, campo);
    const valor = texto(nodo?.["body"]) ?? texto(nodo?.["contentText"])
      ?? texto(nodo?.["description"]);
    if (valor) return valor;
  }

  // Lo que respondió quien PULSÓ un botón: para el hilo es su respuesta.
  for (const campo of [
    "templateButtonReplyMessage", "buttonsResponseMessage", "listResponseMessage",
  ]) {
    const nodo = m[campo] as Record<string, unknown> | undefined;
    const valor = nodo?.["selectedDisplayText"] ?? nodo?.["selectedButtonId"]
      ?? nodo?.["title"];
    if (typeof valor === "string" && valor !== "") return valor;
  }

  return null;
}

/** Un hijo de un nodo, cuando es un objeto; `undefined` en cualquier otro caso. */
function dentro(
  nodo: Record<string, unknown> | undefined, campo: string,
): Record<string, unknown> | undefined {
  const hijo = nodo?.[campo];
  return hijo && typeof hijo === "object" ? hijo as Record<string, unknown> : undefined;
}

/** Un nodo de texto de WhatsApp: a veces `{text}`, a veces la cadena pelada. */
function texto(nodo: unknown): string | null {
  if (typeof nodo === "string") return nodo === "" ? null : nodo;
  const valor = (nodo as { text?: unknown } | undefined)?.text;
  return typeof valor === "string" && valor !== "" ? valor : null;
}

/**
 * Nodos que acompañan a un mensaje sin ser el mensaje.
 *
 * Si un sobre no trae NADA más que estos, no ha pasado nada que contar: son
 * datos de cifrado y de contexto. Llegaban al hilo como «mensaje no
 * compatible», y eran la mitad de los que aparecían así.
 */
const SIN_CONTENIDO = new Set([
  "messageContextInfo", "senderKeyDistributionMessage", "deviceSentMessage",
  /*
   * La cabecera de un álbum y el registro de una llamada no llevan contenido
   * propio: las fotos del álbum llegan después una a una, y la llamada ya va
   * por su propio evento (`call.received`). Enseñarlos en el hilo era pintar
   * dos veces lo mismo, y encima como ilegible.
   */
  "albumMessage", "call",
]);

/** `true` si el sobre no lleva nada que una persona pueda leer. */
export function esVacio(m: WAMessage): boolean {
  const msg = contenido(m);
  if (!msg) return true;
  return Object.keys(msg).every((k) => SIN_CONTENIDO.has(k));
}

export function messageKind(m: WAMessage): MessageKind {
  const msg = contenido(m);
  if (!msg) return "unknown";
  if (msg["conversation"] || msg["extendedTextMessage"]) return "text";
  if (msg["imageMessage"]) return "image";
  if (msg["videoMessage"] || msg["ptvMessage"]) return "video";
  if (msg["audioMessage"]) return "audio";
  if (msg["documentMessage"]) return "document";
  if (msg["stickerMessage"]) return "sticker";
  if (msg["locationMessage"] || msg["liveLocationMessage"]) return "location";
  if (msg["contactMessage"] || msg["contactsArrayMessage"]) return "contact";
  if (msg["pollCreationMessage"] || msg["pollCreationMessageV3"]) return "poll";
  if (msg["reactionMessage"]) return "reaction";
  if (msg["protocolMessage"]) return "system";
  // Plantillas e interactivos: lo que manda una empresa. Son mensajes de
  // verdad, con texto y botones, y se trataban como ilegibles.
  if (msg["templateMessage"] || msg["interactiveMessage"]) return "template";
  if (msg["buttonsMessage"]) return "buttons";
  if (msg["listMessage"]) return "list";
  // Una respuesta a un botón es, para el hilo, lo que esa persona contestó.
  if (
    msg["templateButtonReplyMessage"] || msg["buttonsResponseMessage"]
    || msg["listResponseMessage"] || msg["interactiveResponseMessage"]
  ) return "text";
  return "unknown";
}

function toGroupMetadata(meta: {
  id: string; subject: string; desc?: string | null | undefined;
  owner?: string | null | undefined; creation?: number | null | undefined;
  participants: { id: string; admin?: string | null | undefined }[];
}): GroupMetadata {
  return {
    address: parseAddress(meta.id),
    subject: meta.subject,
    ...(meta.desc ? { description: meta.desc } : {}),
    ...(meta.owner ? { owner: parseAddress(meta.owner) } : {}),
    participants: meta.participants.map((p) => ({
      address: parseAddress(p.id),
      role: p.admin === "superadmin" ? "superadmin" : p.admin === "admin" ? "admin" : "member",
    })),
    ...(meta.creation ? { createdAt: meta.creation * 1000 } : {}),
  };
}

/** Un registro que no dice nada: el nuestro ya sale por los eventos. */
const REGISTRO_MUDO = {
  level: "silent",
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  fatal: () => {},
  child: () => REGISTRO_MUDO,
} as unknown as Parameters<typeof downloadMediaMessage>[3] extends { logger: infer L } ? L : never;

/** La forma de Baileys para una comunidad, traducida a la nuestra. */
function toCommunityMetadata(
  meta: { id: string; subject?: string; desc?: string; owner?: string; size?: number },
  enlazados: readonly { id?: string; subject?: string; size?: number }[],
): CommunityMetadata {
  const dueno = meta.owner ? tryParseAddress(meta.owner) : null;
  return {
    address: parseAddress(meta.id),
    subject: meta.subject ?? "",
    ...(meta.desc ? { description: meta.desc } : {}),
    ...(dueno ? { owner: dueno } : {}),
    linkedGroups: enlazados
      .filter((g) => g.id)
      .map((g) => ({
        address: parseAddress(String(g.id)),
        subject: g.subject ?? "",
        ...(g.size !== undefined ? { size: g.size } : {}),
      })),
    ...(meta.size !== undefined ? { size: meta.size } : {}),
  };
}

/** La forma de Baileys para un producto, traducida a la nuestra. */
function toProduct(p: {
  id: string; name: string; description: string; price: number; currency: string;
  retailerId?: string; url?: string; isHidden?: boolean; availability?: string;
  imageUrls?: Record<string, string>; reviewStatus?: Record<string, string>;
}): Product {
  return {
    id: String(p.id), name: p.name, description: p.description,
    price: p.price, currency: p.currency,
    ...(p.retailerId ? { retailerId: p.retailerId } : {}),
    ...(p.url ? { url: p.url } : {}),
    imageUrls: Object.values(p.imageUrls ?? {}),
    ...(p.isHidden !== undefined ? { hidden: p.isHidden } : {}),
    ...(p.availability ? { availability: p.availability } : {}),
    ...(Object.values(p.reviewStatus ?? {})[0]
      ? { reviewStatus: Object.values(p.reviewStatus ?? {})[0] }
      : {}),
  };
}

/** Los últimos mensajes en la forma que pide `chatModify`. */
function anclaBaileys(
  chat: Address, anchor: readonly ChatAnchorMessage[],
): { key: { id: string; remoteJid: string; fromMe: boolean }; messageTimestamp: number }[] {
  return anchor.map((m) => ({
    key: { id: m.providerMessageId, remoteJid: chat.value, fromMe: m.fromMe },
    messageTimestamp: Math.floor(m.timestamp / 1000),
  }));
}

/** La forma de Baileys para un canal, traducida a la nuestra. */
function toNewsletterMetadata(m: {
  id: string; name?: string; description?: string; invite?: string;
  subscribers?: number; verification?: string; creation_time?: number;
  viewer_metadata?: { role?: string };
}): NewsletterMetadata {
  const rol = m.viewer_metadata?.role?.toLowerCase();
  return {
    address: parseAddress(m.id),
    name: m.name ?? "",
    ...(m.description ? { description: m.description } : {}),
    ...(m.invite ? { inviteCode: m.invite } : {}),
    ...(typeof m.subscribers === "number" ? { subscribers: m.subscribers } : {}),
    ...(m.verification ? { verified: m.verification === "VERIFIED" } : {}),
    ...(rol === "owner" || rol === "admin" || rol === "subscriber" || rol === "guest"
      ? { role: rol }
      : {}),
    ...(m.creation_time ? { createdAt: m.creation_time * 1000 } : {}),
  };
}
