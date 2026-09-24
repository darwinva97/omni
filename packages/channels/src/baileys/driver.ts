import { createHash } from "node:crypto";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers, DisconnectReason, fetchLatestBaileysVersion,
  type WAMessage, type WASocket,
} from "baileys";
import {
  capabilitySet, OmniError, parseAddress, tryParseAddress,
  type Address, type ChannelDescriptor, type DeliveryState, type LineId, type MessageKind,
} from "@omni/shared";
import {
  EventEmitterBase,
  type ChannelDriver, type ConnectRequest, type ConnectResult,
  type GroupMetadata, type LineStatus, type OutboundCommand, type SendReceipt,
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
    "contact.check", "contact.block", "contact.profile", "identity.lid",
    "call.receive", "call.reject",
    "newsletter.read", "history.sync", "media.decrypt",
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
   * Envíos recientes por `clientMessageId`.
   *
   * La cola ya evita encolar dos veces, pero un trabajo SÍ se reintenta: si el
   * primer intento llegó a WhatsApp y falló al anotarse, el reintento mandaría
   * el mensaje otra vez. Esto lo corta dentro del proceso.
   */
  readonly recent: Map<string, SendReceipt>;
}

export type SocketFactory = (opts: Parameters<typeof makeWASocket>[0]) => WASocket;

export interface BaileysOptions {
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

  constructor(opts: BaileysOptions = {}) {
    super();
    this.#make = opts.makeSocket ?? ((o) => makeWASocket(o));
    this.#fetchVersion = opts.fetchVersion ?? fetchLatestBaileysVersion;
    this.#reconnectBaseMs = opts.reconnectBaseMs ?? 2000;
    this.#maxAttempts = opts.maxReconnectAttempts ?? 5;
    this.#linkWaitMs = opts.linkWaitMs ?? 8000;
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
      ...(config["proxyUrl"] ? { agent: undefined } : {}),
      getMessage: async () => undefined,
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
      if (type !== "notify") return;
      for (const m of messages) void this.#onMessage(lineId, line, m);
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
        void this.emit("message.receipt", line.orgId, lineId, {
          key: normalizeKey(u.key), state: estado, participant: u.receipt.userJid,
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

    ev.on("contacts.update", (contacts) => {
      for (const c of contacts) {
        void this.emit("contact.updated", line.orgId, lineId, {
          address: c.id, pushName: c.notify ?? null, name: c.name ?? null,
        });
      }
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
    const payload = {
      key: normalizeKey(m.key),
      pushName: m.pushName ?? null,
      kind: messageKind(m),
      text: extractText(m.message ?? null),
      timestamp: Number(m.messageTimestamp ?? 0) * 1000,
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

  async createGroup(lineId: LineId, subject: string, participants: readonly string[]): Promise<GroupMetadata> {
    const { socket } = this.#require(lineId);
    const meta = await socket.groupCreate(subject, participants.map((p) => parseAddress(p).value));
    return toGroupMetadata(meta);
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
  return `3EB0${hash.slice(0, 28)}`;
}

function normalizeKey(key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null }) {
  return {
    id: key.id ?? "",
    remoteJid: key.remoteJid ?? "",
    fromMe: key.fromMe ?? false,
    ...(key.participant ? { participant: key.participant } : {}),
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
export function extractText(message: object | null | undefined): string | null {
  if (!message) return null;
  const m = message as Record<string, { text?: string; caption?: string } | string | undefined>;
  if (typeof m["conversation"] === "string") return m["conversation"];
  for (const campo of ["extendedTextMessage", "imageMessage", "videoMessage", "documentMessage"]) {
    const nodo = m[campo];
    if (nodo && typeof nodo === "object") {
      const valor = nodo.text ?? nodo.caption;
      if (typeof valor === "string") return valor;
    }
  }
  return null;
}

export function messageKind(m: WAMessage): MessageKind {
  const msg = m.message as Record<string, unknown> | null | undefined;
  if (!msg) return "unknown";
  if (msg["conversation"] || msg["extendedTextMessage"]) return "text";
  if (msg["imageMessage"]) return "image";
  if (msg["videoMessage"]) return "video";
  if (msg["audioMessage"]) return "audio";
  if (msg["documentMessage"]) return "document";
  if (msg["stickerMessage"]) return "sticker";
  if (msg["locationMessage"]) return "location";
  if (msg["contactMessage"] || msg["contactsArrayMessage"]) return "contact";
  if (msg["pollCreationMessage"] || msg["pollCreationMessageV3"]) return "poll";
  if (msg["reactionMessage"]) return "reaction";
  if (msg["protocolMessage"]) return "system";
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
