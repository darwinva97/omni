import { createDecipheriv, createHash, hkdfSync } from "node:crypto";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  type Contact as Contacto,
  Browsers, decryptPollVote, DisconnectReason, downloadMediaMessage,
  fetchLatestBaileysVersion, getContentType, getKeyAuthor, normalizeMessageContent, proto,
  type WAMessage, type WASocket,
} from "baileys";
import {
  capabilitySet, OmniError, parseAddress, tryParseAddress,
  type Address, type ChannelDescriptor, type DeliveryState, type LineId, type MessageKind,
} from "@omni/shared";
import {
  EventEmitterBase, PRESENCIA_ALQUILER_MS,
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
    "chat.read", "chat.presence", "chat.typing", "presence.watch", "chat.archive", "chat.mute", "chat.ephemeral",
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
   * El alquiler de «en línea»: cuándo vence, y el temporizador que vuelve a
   * poner la cuenta fuera de línea. Ver `watchPresence`.
   */
  enLinea: { hasta: number; temporizador: ReturnType<typeof setTimeout> } | null;
  /** A quién ya se pidió seguir, y cuándo: no hace falta repetirlo cada vez. */
  readonly seguidas: Map<string, number>;
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
      enLinea: null,
      seguidas: new Map(),
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
    // Un socket nuevo nace fuera de línea y sin seguir a nadie: lo anterior
    // era del socket viejo, y darlo por vigente dejaría de pedirlo.
    if (line.enLinea) clearTimeout(line.enLinea.temporizador);
    line.enLinea = null;
    line.seguidas.clear();
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
          savedName: c.name ?? null,
          /*
           * El nombre verificado de una empresa va con el que la persona se
           * puso, no con el de agenda: lo eligió ella, no tú. Mezclado con
           * el de agenda ganaba a todo, y una empresa que tienes guardada
           * como «Banco» salía con su nombre comercial.
           */
          pushName: c.notify ?? c.verifiedName ?? null,
          // El @usuario de WhatsApp, cuando lo tiene: tercero en el orden.
          ...(c.username ? { username: c.username } : {}),
          /*
           * Sus DOS direcciones, cuando vienen.
           *
           * La agenda guarda a la gente por su teléfono y los chats se abren
           * con su LID: sin saber que son la misma persona, el nombre que le
           * pusiste no llega a la conversación. Esto se tiraba.
           */
          ...(c.lid ? { lid: c.lid } : {}),
          ...(c.phoneNumber ? { phone: c.phoneNumber } : {}),
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
    /*
     * Las parejas LID ↔ teléfono que WhatsApp va revelando.
     *
     * Es lo que une un chat abierto por LID con el nombre que le pusiste por
     * su número. Baileys las anuncia en dos sitios y no las escuchaba nadie.
     * Salen como `contact.updated` sin nombres: el motor aprende la pareja y
     * no toca ninguna ficha.
     */
    const anotarParejas = (parejas: readonly { lid?: string; pn?: string }[]): void => {
      for (const p of parejas) {
        if (!p.lid || !p.pn) continue;
        void this.emit("contact.updated", line.orgId, lineId, {
          address: p.pn, lid: p.lid, phone: p.pn,
        });
      }
    };
    ev.on("lid-mapping.update", (pareja) => anotarParejas([pareja]));

    ev.on("messaging-history.set", ({ contacts, lidPnMappings }) => {
      if (contacts?.length) anotarContactos(contacts);
      if (lidPnMappings?.length) anotarParejas(lidPnMappings);
    });

    ev.on("chats.update", (chats) => {
      for (const c of chats) {
        /*
         * Se emite lo que CAMBIÓ, no lo que falta.
         *
         * WhatsApp manda una actualización con solo los campos tocados, así
         * que un `?? null` convertía «esto no cambió» en «esto se puso a
         * nada»: silenciar desde el teléfono llegaba aquí como un chat
         * archivado y sin pendientes. `undefined` se omite, y quien lo reciba
         * sabe distinguir ambas cosas.
         */
        void this.emit("chat.updated", line.orgId, lineId, {
          chat: c.id,
          ...(c.unreadCount !== undefined ? { unreadCount: c.unreadCount } : {}),
          ...(c.archived !== undefined ? { archived: c.archived } : {}),
          ...(c.pinned !== undefined ? { pinned: Boolean(c.pinned) } : {}),
          /*
           * El silencio se guarda como INSTANTE, que es como lo entiende
           * WhatsApp: «hasta las seis», no «ocho horas». Una duración
           * guardada caduca mal en cuanto el proceso se reinicia.
           */
          ...(c.muteEndTime !== undefined
            ? { mutedUntil: c.muteEndTime ? Number(c.muteEndTime) : null }
            : {}),
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
     * Un voto de encuesta NO es un mensaje.
     *
     * Llega por el mismo canal que los mensajes, cifrado y apuntando a la
     * encuesta a la que responde. Guardarlo como fila propia llenaba el hilo:
     * una encuesta de un grupo de cincuenta personas son cincuenta burbujas
     * vacías con «mensaje no compatible» dentro, que es como se vio.
     *
     * Aquí no se descifra: la clave está en la encuesta, que vive en la base,
     * y el driver no la tiene. Se entrega el voto cifrado con todo lo que hace
     * falta para abrirlo, y lo abre quien sí puede.
     */
    const estado = line.status;
    const propia = estado.state === "connected" ? estado.self.value : undefined;

    /*
     * Una edición cifrada NO es un mensaje.
     *
     * En los grupos y en los chats con direccionamiento por LID, WhatsApp
     * manda las ediciones cifradas con el secreto del mensaje original. Se
     * guardaban como mensaje propio y salía «Mensaje no compatible» debajo
     * del original, que seguía con el texto viejo. Aquí no se abre —la clave
     * está en el original, que vive en la base— y se entrega como cambio del
     * mensaje al que apunta.
     */
    const edicion = extractSecretEdit(m, propia);
    if (edicion) {
      await this.emit("message.updated", line.orgId, lineId, edicion);
      return;
    }

    const voto = extractPollVote(m, propia);
    if (voto) {
      await this.emit("poll.vote", line.orgId, lineId, voto);
      return;
    }

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
      // La cita va con el mensaje, no se busca después: solo viene aquí.
      ...(() => {
        const cita = extractReply(m);
        return cita ? { replyTo: cita } : {};
      })(),
      // A quién menciona. El texto solo trae `@número`; quién es cada número
      // viene aquí, y sin guardarlo el nombre no se puede poner luego.
      ...(() => {
        const menciones = extractMentions(m);
        return menciones.length > 0 ? { mentions: menciones } : {};
      })(),
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
    if (line.enLinea) clearTimeout(line.enLinea.temporizador);
    line.enLinea = null;
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

  /**
   * En línea un rato, y siguiendo la presencia de una conversación.
   *
   * WhatsApp solo entrega el «escribiendo…» de los demás a una cuenta que está
   * en línea, y esta conecta FUERA de línea a propósito (`markOnlineOnConnect:
   * false`): mientras haya un cliente en línea, el teléfono deja de recibir
   * avisos. Así que se hace como WhatsApp Web: en línea mientras alguien mira
   * el panel, y fuera en cuanto deja de renovarlo.
   *
   * `presenceSubscribe` es lo que trae el «en línea» y la última conexión de
   * esa persona. Se pide una vez cada diez minutos por conversación, no en
   * cada renovación.
   */
  async watchPresence(lineId: LineId, chat: Address | null): Promise<void> {
    const { line, socket } = this.#require(lineId);

    if (!line.enLinea) await socket.sendPresenceUpdate("available");
    else clearTimeout(line.enLinea.temporizador);
    const temporizador = setTimeout(() => {
      line.enLinea = null;
      // Si la conexión ya cayó, no hay nada que apagar.
      void line.socket?.sendPresenceUpdate("unavailable").catch(() => {});
    }, PRESENCIA_ALQUILER_MS);
    // Un temporizador pendiente no debe impedir que el proceso termine.
    temporizador.unref?.();
    line.enLinea = { hasta: Date.now() + PRESENCIA_ALQUILER_MS, temporizador };

    if (chat) {
      const antes = line.seguidas.get(chat.value) ?? 0;
      if (Date.now() - antes > 10 * 60_000) {
        line.seguidas.set(chat.value, Date.now());
        await socket.presenceSubscribe(chat.value).catch(() => {
          // Sin suscripción se pierde el «en línea», no el «escribiendo».
          line.seguidas.delete(chat.value);
        });
      }
    }
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

    const nodo = nodoDeMedio(m);

    /*
     * Un canal no cifra sus ficheros: no hay `mediaKey`, y Baileys se niega a
     * descargar sin ella («Cannot derive from empty media key»). Se piden tal
     * cual al servidor de medios. Eran las 35 fotos del canal que salían como
     * «No se pudo descargar».
     */
    let bytes: Uint8Array;
    if (nodo && !nodo.mediaKey && nodo.directPath) {
      const res = await fetch(`https://${HOST_DE_MEDIOS}${nodo.directPath}`);
      if (!res.ok) throw new Error(`el servidor de medios respondió ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } else {
      /*
       * El servidor de donde bajar el fichero.
       *
       * Baileys lo saca del campo `url`, y WhatsApp a veces manda ahí un
       * servidor de relleno sin ruta —«https://a.whatsapp.net», que ni
       * siquiera existe— en vez de la URL de verdad. Todos los stickers que
       * llegaban así fallaban con «fetch failed», los cuatro reintentos
       * contra el mismo sitio. Solo se usa el servidor de `url` cuando es una
       * URL completa; si no, el de siempre, con la ruta de `directPath`.
       */
      const host = hostDeMedio(nodo?.url);
      const bajar = (h: string) => downloadMediaMessage(m, "buffer", { host: h }, {
        // Baileys escribe por aquí; sin un registro mudo saca ruido por consola
        // en cada medio que llega.
        logger: REGISTRO_MUDO,
        /*
         * `reuploadRequest` es lo que salva los medios viejos: si el servidor
         * ya no tiene el fichero, Baileys pide al remitente que lo vuelva a
         * subir. Sin eso, cualquier medio de hace unos días da 404.
         */
        reuploadRequest: socket.updateMediaMessage,
      });
      try {
        bytes = new Uint8Array(await bajar(host));
      } catch (e) {
        /*
         * Y si falla la RED —no una respuesta del servidor— con un servidor
         * que no es el de siempre, se intenta una vez con el de siempre. Es
         * la red de seguridad para el próximo servidor raro que mande
         * WhatsApp: un 404 sí es una respuesta y no se repite.
         */
        const respondio = typeof (e as { status?: unknown })?.status === "number"
          || typeof (e as { output?: { statusCode?: unknown } })?.output?.statusCode === "number";
        if (respondio || host === HOST_DE_MEDIOS) throw e;
        bytes = new Uint8Array(await bajar(HOST_DE_MEDIOS));
      }
    }

    const contenido = normalizeMessageContent(m.message) ?? m.message;
    const info =
      contenido.imageMessage ?? contenido.videoMessage ?? contenido.audioMessage ??
      contenido.documentMessage ?? contenido.stickerMessage;
    return {
      bytes,
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

  // Los avisos, con el texto que pone WhatsApp. Sin nombre: lo pone el panel.
  const fijado = m["pinInChatMessage"] as { type?: number | string } | undefined;
  if (fijado) {
    return fijado.type === 2 || fijado.type === "UNPIN_FOR_ALL"
      ? "dejó de fijar un mensaje" : "fijó un mensaje";
  }
  if (m["messageHistoryNotice"]) return "compartió los mensajes recientes del grupo";

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
  /*
   * El paquete con el historial que se comparte al entrar en un grupo. Es un
   * fichero de mensajes, no algo que leer; el aviso que lo acompaña
   * (`messageHistoryNotice`) es el que se enseña.
   */
  "messageHistoryBundle",
]);

/** `true` si el sobre no lleva nada que una persona pueda leer. */
export function esVacio(m: WAMessage): boolean {
  const msg = contenido(m);
  if (!msg) return true;
  return Object.keys(msg).every((k) => SIN_CONTENIDO.has(k));
}

/**
 * Unos bytes del protocolo, en base64, vengan como vengan.
 *
 * WhatsApp los entrega como `Uint8Array`, pero el nodo original se guarda tal
 * cual en la base y al releerlo de JSON ya son una cadena en base64. Tratar la
 * cadena como bytes la codifica otra vez: la clave sale distinta, el voto no
 * abre, y no hay ningún error que lo diga. Pasó, y por eso esto existe.
 */
function enBase64(v: Uint8Array | string | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : Buffer.from(v).toString("base64");
}

/**
 * El voto cifrado de una encuesta, si el sobre es eso.
 *
 * Se devuelven los dos extremos que hacen falta para descifrarlo —quién creó
 * la encuesta y quién votó—, porque la clave se deriva de ambos junto con el
 * identificador de la encuesta. Sin uno de ellos el voto es ilegible.
 */
export function extractPollVote(m: WAMessage, propia?: string): {
  poll: { id: string; author: string };
  voter: string;
  vote: { encPayload: string; encIv: string };
  at: number;
} | null {
  const msg = contenido(m);
  const nodo = msg?.["pollUpdateMessage"] as {
    pollCreationMessageKey?: { id?: string; fromMe?: boolean; remoteJid?: string;
      participant?: string };
    vote?: { encPayload?: Uint8Array | string; encIv?: Uint8Array | string };
    senderTimestampMs?: number | string;
  } | undefined;
  const clave = nodo?.pollCreationMessageKey;
  if (!clave?.id || !nodo?.vote?.encPayload || !nodo.vote.encIv) return null;

  /*
   * `getKeyAuthor` de Baileys y no el participante a secas.
   *
   * Cuando la encuesta la creamos NOSOTROS —o el voto es nuestro— el autor no
   * viene en la clave: es nuestra propia dirección, que hay que poner. Y la
   * clave de cifrado se deriva de esas direcciones, así que equivocarse ahí no
   * da un error, da un voto que no abre.
   */
  const autor = getKeyAuthor(clave as never, propia);
  const votante = getKeyAuthor(m.key as never, propia);
  if (!autor || !votante) return null;

  return {
    poll: { id: clave.id, author: autor },
    voter: votante,
    vote: {
      encPayload: enBase64(nodo.vote.encPayload)!,
      encIv: enBase64(nodo.vote.encIv)!,
    },
    at: Number(nodo.senderTimestampMs ?? Date.now()),
  };
}

/**
 * Una edición cifrada, si el sobre es eso.
 *
 * `targetMessageKey` es el mensaje editado, visto DESDE quien edita: su
 * `remoteJid` puede ser nuestra propia dirección en un chat de dos. Por eso la
 * clave del mensaje se rehace con el chat del sobre, que es el nuestro.
 *
 * `author` es quien edita, que es también quien escribió el original: solo se
 * puede editar lo propio. Comprobado contra 50 ediciones reales: la clave se
 * deriva con esa dirección tal cual viene en el sobre —el participante en un
 * grupo, el chat en uno de dos—.
 */
export function extractSecretEdit(m: WAMessage, propia?: string): {
  key: { id: string; remoteJid: string; participant?: string; fromMe: boolean };
  author: string;
  /** Otras formas de la misma dirección, por si la primera no abre. */
  alternativas: string[];
  cifrado: { encPayload: string; encIv: string; tipo: string };
  timestamp: number;
} | null {
  const msg = contenido(m);
  const nodo = msg?.["secretEncryptedMessage"] as {
    targetMessageKey?: { id?: string };
    encPayload?: Uint8Array | string; encIv?: Uint8Array | string;
    secretEncType?: number | string;
  } | undefined;
  const id = nodo?.targetMessageKey?.id;
  if (!id || !nodo?.encPayload || !nodo.encIv || !m.key.remoteJid) return null;
  /*
   * La dirección del autor TAL COMO VIENE en el sobre: el participante en un
   * grupo, el chat en uno de dos. No la de `getKeyAuthor`, que prefiere el
   * teléfono cuando lo hay: con esa, 23 de 50 ediciones reales no abrían. Lo
   * propio va con nuestra dirección. Las demás formas quedan de reserva.
   */
  const k = m.key as { participant?: string | null; participantAlt?: string | null;
    remoteJid?: string | null; remoteJidAlt?: string | null; fromMe?: boolean | null };
  // Lo propio: en un grupo el sobre trae nuestro participante —a menudo el
  // LID—, que es con lo que se cifró; la dirección de la línea, de reserva.
  const tal = m.key.fromMe ? (k.participant || propia) : (k.participant || k.remoteJid);
  const sinDispositivo = (j: string) => j.replace(/:\d+@/, "@");
  const formas = [tal, k.participantAlt, k.remoteJidAlt, propia, getKeyAuthor(m.key as never, propia)]
    .filter((x): x is string => Boolean(x) && x !== "me" && !String(x).endsWith("@g.us"))
    .map(sinDispositivo);
  const [author, ...resto] = [...new Set(formas)];
  if (!author) return null;
  // El tipo, tal como viene: número o nombre según de dónde salga el nodo.
  const tipo = nodo.secretEncType === 2 || nodo.secretEncType === "MESSAGE_EDIT"
    ? "MESSAGE_EDIT" : String(nodo.secretEncType ?? "");
  return {
    key: {
      id, remoteJid: m.key.remoteJid, fromMe: Boolean(m.key.fromMe),
      ...(m.key.participant ? { participant: m.key.participant } : {}),
    },
    author,
    alternativas: resto,
    cifrado: { encPayload: enBase64(nodo.encPayload)!, encIv: enBase64(nodo.encIv)!, tipo },
    timestamp: Number(m.messageTimestamp ?? 0) * 1000,
  };
}

/**
 * Abre una edición cifrada y devuelve el texto nuevo.
 *
 * El esquema es el de los votos —HKDF-SHA256 con el `messageSecret` del
 * original y AES-256-GCM— con «Message Edit» como caso de uso y SIN dato
 * adicional. Baileys no lo trae; la receta se sacó probando contra ediciones
 * reales, y el GCM solo abre con la clave exacta, así que no hay acierto a
 * medias. Lanza si la clave no abre.
 */
export function descifrarEdicion(
  cifrado: { encPayload: string; encIv: string },
  ctx: { messageId: string; author: string; secret: string },
): { text: string | null; editedAt: number | null } {
  const info = Buffer.concat([
    Buffer.from(ctx.messageId), Buffer.from(ctx.author), Buffer.from(ctx.author),
    Buffer.from("Message Edit"),
  ]);
  const clave = Buffer.from(hkdfSync(
    "sha256", Buffer.from(ctx.secret, "base64"), Buffer.alloc(0), info, 32));
  const cuerpo = Buffer.from(cifrado.encPayload, "base64");
  const d = createDecipheriv("aes-256-gcm", clave, Buffer.from(cifrado.encIv, "base64"));
  d.setAuthTag(cuerpo.subarray(-16));
  const plano = Buffer.concat([d.update(cuerpo.subarray(0, -16)), d.final()]);
  const msg = proto.Message.decode(plano);
  const pm = msg.protocolMessage;
  const editado = pm?.editedMessage ?? msg;
  /*
   * `timestampMs` es un entero de 64 bits de protobuf (`Long`), y `Number()`
   * de un `Long` da NaN: la fecha salía inválida y el guardado fallaba entero.
   * Por su texto se convierte bien.
   */
  const ms = pm?.timestampMs != null ? Number(String(pm.timestampMs)) : null;
  return { text: extractText(editado as object), editedAt: ms !== null && Number.isFinite(ms) ? ms : null };
}

/**
 * Abre un voto cifrado y dice qué opciones marcó quien votó.
 *
 * WhatsApp no manda el nombre de la opción: manda su SHA-256. Las opciones de
 * la encuesta vienen aparte, se hashean igual y se emparejan. Es lo que
 * permite enseñar «Martes 20: 7 votos» en vez de un montón de bytes.
 *
 * Vive aquí y no en el motor porque es conocimiento del protocolo, y el motor
 * no debe saber cómo cifra WhatsApp. Lo que el motor pone es la clave, que
 * sale de la encuesta guardada.
 */
export function descifrarVoto(
  vote: { encPayload: string; encIv: string },
  ctx: { pollId: string; pollAuthor: string; voter: string; secret: string },
  opciones: readonly string[],
): string[] {
  const abierto = decryptPollVote(
    {
      encPayload: Buffer.from(vote.encPayload, "base64"),
      encIv: Buffer.from(vote.encIv, "base64"),
    },
    {
      pollEncKey: Buffer.from(ctx.secret, "base64"),
      pollCreatorJid: ctx.pollAuthor,
      pollMsgId: ctx.pollId,
      voterJid: ctx.voter,
    },
  );

  const porHash = new Map(
    opciones.map((o) => [createHash("sha256").update(o).digest("hex"), o]),
  );
  return (abierto.selectedOptions ?? [])
    .map((h) => porHash.get(Buffer.from(h).toString("hex")))
    .filter((o): o is string => o !== undefined);
}

/** La pregunta y las opciones de una encuesta, de su nodo original. */
export function encuestaDe(m: WAMessage): {
  question: string; options: string[]; secret: string | null; multiple: boolean;
} | null {
  const msg = contenido(m);
  const nodo = (msg?.["pollCreationMessage"] ?? msg?.["pollCreationMessageV3"]
    ?? msg?.["pollCreationMessageV2"] ?? msg?.["pollCreationMessageV4"] ?? msg?.["pollCreationMessageV5"]) as {
      name?: string;
      options?: { optionName?: string }[];
      selectableOptionsCount?: number;
    } | undefined;
  if (!nodo) return null;

  const secreto = (msg?.["messageContextInfo"] as { messageSecret?: Uint8Array | string }
    | undefined)?.messageSecret;
  return {
    question: nodo.name ?? "",
    options: (nodo.options ?? []).map((o) => o.optionName ?? "").filter((o) => o !== ""),
    secret: enBase64(secreto),
    /*
     * `0` significa «tantas como quieras», no «ninguna». Es lo que WhatsApp
     * pone en una encuesta de opción múltiple, y leerlo al revés enseñaría
     * «elige una» en una donde se pueden elegir varias.
     */
    multiple: (nodo.selectableOptionsCount ?? 0) !== 1,
  };
}

/**
 * A quién menciona un mensaje.
 *
 * Como la cita, vive en el `contextInfo` del nodo del contenido y no arriba.
 * Se devuelven las direcciones tal cual: el número que aparece en el texto es
 * la parte de usuario de cada una, y emparejarlos es cosa de quien pinte.
 */
export function extractMentions(m: WAMessage): string[] {
  const msg = contenido(m);
  if (!msg) return [];
  const tipo = getContentType(msg as never);
  if (!tipo) return [];
  const ctx = (msg[tipo] as { contextInfo?: { mentionedJid?: unknown } } | undefined)
    ?.contextInfo;
  const lista = ctx?.mentionedJid;
  return Array.isArray(lista)
    ? [...new Set(lista.filter((x): x is string => typeof x === "string" && x.includes("@")))]
    : [];
}

/** El servidor de medios de WhatsApp, el mismo que usa Baileys por defecto. */
export const HOST_DE_MEDIOS = "mmg.whatsapp.net";

/**
 * De qué servidor bajar un fichero, a partir de su campo `url`.
 *
 * Solo se fía de una URL COMPLETA —servidor y ruta— de WhatsApp. Un servidor
 * sin ruta («https://a.whatsapp.net») es un relleno que no sirve ficheros: se
 * vio en 106 stickers, todos sin descargar. Ante la duda, el de siempre.
 */
export function hostDeMedio(url: string | null | undefined): string {
  if (!url) return HOST_DE_MEDIOS;
  try {
    const u = new URL(url);
    const completa = u.pathname.length > 1;
    const deWhatsApp = u.hostname === "whatsapp.net" || u.hostname.endsWith(".whatsapp.net");
    return completa && deWhatsApp && u.protocol === "https:" ? u.host : HOST_DE_MEDIOS;
  } catch {
    return HOST_DE_MEDIOS;
  }
}

/** El nodo del fichero de un mensaje: imagen, vídeo, audio, documento o sticker. */
function nodoDeMedio(m: WAMessage): {
  url?: string | null; directPath?: string | null; mediaKey?: unknown;
} | null {
  const c = normalizeMessageContent(m.message ?? undefined) as Record<string, unknown> | undefined;
  if (!c) return null;
  for (const campo of ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage", "ptvMessage"]) {
    const n = c[campo];
    if (n && typeof n === "object") return n as { url?: string; directPath?: string; mediaKey?: unknown };
  }
  return null;
}

/**
 * Lo que hace falta para CITAR un fichero como lo cita WhatsApp.
 *
 * Una foto o un vídeo de WhatsApp lleva dentro una miniatura JPEG diminuta
 * (`jpegThumbnail`): es lo que el teléfono enseña en la cita, sin descargar
 * nada. Un audio no tiene imagen, tiene duración; un documento, nombre. Sirve
 * igual para el mensaje original guardado y para la copia que viaja dentro de
 * la respuesta. Lo que no reconoce lo devuelve vacío.
 */
export function detallesDeMedio(message: object | null | undefined): {
  thumb: string | null; seconds: number | null; ptt: boolean; fileName: string | null;
} {
  const vacio = { thumb: null, seconds: null, ptt: false, fileName: null };
  if (!message) return vacio;
  const m = (normalizeMessageContent(message as never) ?? message) as Record<string, unknown>;
  const tipo = getContentType(m as never);
  const nodo = tipo ? (m[tipo] as Record<string, unknown> | undefined) : undefined;
  if (!nodo || typeof nodo !== "object") return vacio;
  const seconds = Number(nodo["seconds"]);
  return {
    thumb: enBase64(nodo["jpegThumbnail"] as Uint8Array | string | undefined),
    seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    ptt: nodo["ptt"] === true,
    fileName: typeof nodo["fileName"] === "string" ? nodo["fileName"] : null,
  };
}

/** La copia del citado que viaja dentro de una respuesta, si la trae. */
export function citadoDe(message: object | null | undefined): object | null {
  if (!message) return null;
  const m = (normalizeMessageContent(message as never) ?? message) as Record<string, unknown>;
  const tipo = getContentType(m as never);
  const ctx = tipo
    ? (m[tipo] as { contextInfo?: { quotedMessage?: object } } | undefined)?.contextInfo
    : undefined;
  return ctx?.quotedMessage ?? null;
}

/**
 * A qué mensaje responde, si responde a alguno.
 *
 * WhatsApp manda la cita COMPLETA dentro del mensaje que responde: el
 * identificador del original, quién lo escribió y una copia de su contenido.
 * Eso es lo que permite enseñar la cita de un mensaje que nunca pasó por aquí
 * —de antes de enlazar la línea, o de una conversación que no se sincronizó—,
 * y es por lo que se guarda la copia y no solo el identificador.
 *
 * El `contextInfo` no está arriba: vive dentro del nodo del contenido, y cada
 * tipo tiene el suyo. Qué nodo es lo dice Baileys con `getContentType`.
 */
export function extractReply(m: WAMessage): {
  id: string; author: string | null; kind: MessageKind; text: string | null;
} | null {
  const msg = contenido(m);
  if (!msg) return null;
  const tipo = getContentType(msg as never);
  if (!tipo) return null;
  const ctx = (msg[tipo] as { contextInfo?: Contexto } | undefined)?.contextInfo;
  if (!ctx?.stanzaId) return null;

  const citado = ctx.quotedMessage ?? null;
  return {
    id: ctx.stanzaId,
    author: ctx.participant ?? null,
    kind: citado ? messageKind({ message: citado } as WAMessage) : "unknown",
    text: extractText(citado),
  };
}

type Contexto = {
  stanzaId?: string | null;
  participant?: string | null;
  quotedMessage?: object | null;
};

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
  // Fijar un mensaje y compartir el historial con quien entra: avisos.
  if (msg["pinInChatMessage"] || msg["messageHistoryNotice"]) return "notice";
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
/**
 * Un texto de canal tal como llega.
 *
 * Los tipos publicados de Baileys dicen cadena; lo que devuelve en ejecución es
 * `{ text }`. Se aceptan las dos en vez de fiarse de los tipos: fiarse fue lo
 * que dejó los canales sin nombre.
 */
type TextoDeCanal = string | { text?: string } | null | undefined;

function textoDeCanal(v: TextoDeCanal): string | undefined {
  if (typeof v === "string") return v || undefined;
  return v?.text || undefined;
}

/**
 * La forma de Baileys para un canal, traducida a la nuestra.
 *
 * Baileys devuelve DOS formas según la llamada. Crear un canal da la plana
 * (`name`, `subscribers`); leer uno que ya existe da la respuesta cruda del
 * servidor (`thread_metadata.name.text`, `subscribers_count` como cadena).
 * Esto solo leía la plana, así que todo canal existente salía con el nombre
 * vacío: se vio en un canal real que no había forma de que tuviera título.
 */
export function toNewsletterMetadata(m: {
  id: string; name?: string; description?: string; invite?: string;
  subscribers?: number; verification?: string; creation_time?: number;
  thread_metadata?: {
    name?: TextoDeCanal; description?: TextoDeCanal; invite?: string;
    subscribers_count?: string | number; verification?: string;
    creation_time?: string | number;
  };
  viewer_metadata?: { role?: string };
}): NewsletterMetadata {
  const hilo = m.thread_metadata;
  const nombre = m.name ?? textoDeCanal(hilo?.name) ?? "";
  const descripcion = m.description ?? textoDeCanal(hilo?.description);
  const invitacion = m.invite ?? hilo?.invite;
  const seguidores = m.subscribers ?? (hilo?.subscribers_count !== undefined
    ? Number(hilo.subscribers_count) : undefined);
  const verificacion = m.verification ?? hilo?.verification;
  const creado = m.creation_time ?? (hilo?.creation_time !== undefined
    ? Number(hilo.creation_time) : undefined);
  const rol = m.viewer_metadata?.role?.toLowerCase();

  return {
    address: parseAddress(m.id),
    name: nombre,
    ...(descripcion ? { description: descripcion } : {}),
    ...(invitacion ? { inviteCode: invitacion } : {}),
    ...(typeof seguidores === "number" && Number.isFinite(seguidores)
      ? { subscribers: seguidores } : {}),
    ...(verificacion ? { verified: verificacion === "VERIFIED" } : {}),
    ...(rol === "owner" || rol === "admin" || rol === "subscriber" || rol === "guest"
      ? { role: rol }
      : {}),
    ...(creado && Number.isFinite(creado) ? { createdAt: creado * 1000 } : {}),
  };
}
