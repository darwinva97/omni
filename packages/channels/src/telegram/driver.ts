import {
  capabilitySet, OmniError, parseAddress, resolveContent,
  type Address, type ChannelDescriptor, type LineId,
} from "@omni/shared";
import {
  EventEmitterBase,
  type ChannelDriver, type ConnectRequest, type ConnectResult,
  type GroupMetadata, type LineStatus, type OutboundCommand, type SendReceipt,
} from "../port.js";

/**
 * Driver de Telegram, por su API de bots.
 *
 * Es el primer canal que NO es WhatsApp, y por eso es la prueba de fuego del
 * puerto: si entra sin tocar nada de arriba, la abstracción se sostiene.
 *
 * Tres diferencias de fondo con los transportes de WhatsApp:
 *
 * 1. **Un bot no es una cuenta.** Solo ve lo que se le manda: los mensajes
 *    privados que alguien le escriba y, en grupos, lo que le mencionen —salvo
 *    que su dueño le quite el modo privacidad. No hay historial anterior a él.
 *
 * 2. **No hay acuses.** Telegram no dice "entregado" ni "leído" a un bot, así
 *    que `message.receipts` NO se declara. Un mensaje enviado se queda en
 *    `sent` para siempre, y eso es la verdad, no un fallo.
 *
 * 3. **El identificador de chat es un número opaco**, a veces negativo para
 *    grupos. No es un teléfono y no se puede tratar como tal.
 */

export const TELEGRAM_DESCRIPTOR: ChannelDescriptor = {
  kind: "telegram",
  network: "telegram",
  // Se pega el token que da BotFather. No hay QR ni sesión que caducar.
  linkMethod: "api-key",
  risk: "official",
  // Una conexión HTTP en espera larga; no hay sesión de cifrado que mantener.
  approxMemoryMbPerLine: 2,
  capabilities: capabilitySet(
    "send.text", "send.image", "send.video", "send.audio", "send.document",
    "send.sticker", "send.location", "send.contact", "send.poll",
    "send.reaction", "send.buttons",
    "send.reply",
    "message.edit", "message.delete",
    "chat.presence", "chat.typing",
    "group.read",
    /*
     * Lo que NO está, y por qué:
     *
     * `message.receipts` — Telegram no da acuses a un bot. Declararlo dejaría
     *   a alguien esperando un `delivered` que no llega nunca.
     * `chat.read` — un bot no puede marcar nada como leído.
     * `send.list`, `send.template` — no existen; los botones en línea cubren
     *   el caso de la lista y se declaran como `send.buttons`.
     * `send.mentions` — se mencionan escribiendo dentro del texto, no con un
     *   campo aparte; fingir el campo daría un resultado distinto al pedido.
     * `send.viewOnce`, `send.forward` — no por esta vía.
     * `history.sync` — un bot no ve nada anterior a su llegada al chat.
     * `contact.check` — no hay forma de preguntar si alguien existe.
     * `group.create`, `group.manage`, `group.invite`, `group.participants` —
     *   un bot puede expulsar, pero no crear grupos ni gestionarlos de verdad;
     *   declarar la capacidad entera por una parte sería mentir.
     * `call.*`, `label.*`, `newsletter.*`, `identity.lid`, `media.decrypt` —
     *   no existen en esta red.
     */
  ),
};

interface LineRuntime {
  readonly orgId: string;
  readonly token: string;
  status: LineStatus;
  /** Idempotencia: la misma orden dos veces es una. */
  readonly recent: Map<string, SendReceipt>;
  /** Desplazamiento de `getUpdates`: sin él, cada vuelta repetiría todo. */
  offset: number;
  polling: boolean;
  abort: AbortController | null;
}

export interface TelegramOptions {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  /** Espera larga de `getUpdates`, en segundos. */
  readonly pollSeconds?: number;
  readonly timeoutMs?: number;
  /** Para las pruebas: no arranca el bucle de sondeo. */
  readonly autoPoll?: boolean;
}

interface Respuesta<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramDriver extends EventEmitterBase implements ChannelDriver {
  readonly descriptor = TELEGRAM_DESCRIPTOR;
  readonly #lines = new Map<string, LineRuntime>();
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #pollSeconds: number;
  readonly #timeout: number;
  readonly #autoPoll: boolean;

  constructor(opts: TelegramOptions = {}) {
    super();
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#base = (opts.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.#pollSeconds = opts.pollSeconds ?? 25;
    this.#timeout = opts.timeoutMs ?? 40000;
    this.#autoPoll = opts.autoPoll ?? true;
  }

  // ---------------------------------------------------------------- conexión

  async connect(req: ConnectRequest): Promise<ConnectResult> {
    const token = String(req.config["botToken"] ?? "");
    if (!token) {
      throw new OmniError(
        "validation_failed",
        "este transporte necesita `botToken` en la configuración de la línea; lo da BotFather",
      );
    }

    const line: LineRuntime = {
      orgId: String(req.config["orgId"] ?? ""),
      token,
      status: { state: "connecting" },
      recent: new Map(),
      offset: 0,
      polling: false,
      abort: null,
    };
    this.#lines.set(req.lineId, line);

    const yo = await this.#llamar<{ id: number; username?: string; first_name?: string }>(
      line, "getMe", {},
    ).catch((err: unknown) => {
      line.status = { state: "logged-out", reason: (err as Error).message };
      throw err;
    });

    const self = parseAddress(`${yo.id}@telegram`);
    line.status = {
      state: "connected", self,
      ...(yo.username ? { pushName: `@${yo.username}` } : {}),
    };
    await this.emit("session.connected", line.orgId, req.lineId, { self: self.value });
    await this.emit("session.status", line.orgId, req.lineId, { state: "connected" });

    if (this.#autoPoll) void this.#sondear(req.lineId, line);
    return { status: line.status };
  }

  async disconnect(lineId: LineId): Promise<void> {
    const line = this.#lines.get(lineId);
    if (!line) return;
    line.polling = false;
    line.abort?.abort();
    line.status = { state: "disconnected" };
    await this.emit("session.disconnected", line.orgId, lineId, { reason: "requested" });
  }

  status(lineId: LineId): LineStatus {
    return this.#lines.get(lineId)?.status ?? { state: "disconnected" };
  }

  #require(lineId: string): LineRuntime {
    const line = this.#lines.get(lineId);
    if (!line) throw new OmniError("not_found", `la línea "${lineId}" no está registrada`);
    if (line.status.state !== "connected") {
      throw new OmniError(
        "line_not_connected",
        `la línea "${lineId}" no está conectada (${line.status.state})`,
      );
    }
    return line;
  }

  // ---------------------------------------------------------------- envío

  async send(cmd: OutboundCommand): Promise<SendReceipt> {
    const line = this.#require(cmd.lineId);

    const ya = line.recent.get(cmd.clientMessageId);
    if (ya) return ya;

    const resuelto = resolveContent(cmd.input);
    if (!resuelto.ok) throw new OmniError("validation_failed", resuelto.reason);

    const { metodo, cuerpo } = this.#construir(cmd, resuelto.field);
    const res = await this.#llamar<{ message_id: number; date?: number }>(line, metodo, cuerpo);

    /*
     * Se queda en `sent` y ahí se queda.
     *
     * Telegram no da acuses a un bot, así que avanzar a `delivered` sería
     * inventarse un hecho. Es la razón de que `message.receipts` no esté entre
     * las capacidades.
     */
    const receipt: SendReceipt = {
      providerMessageId: String(res.message_id),
      state: "sent",
      timestamp: res.date ? res.date * 1000 : Date.now(),
    };
    line.recent.set(cmd.clientMessageId, receipt);
    if (line.recent.size > 2000) {
      const primera = line.recent.keys().next().value;
      if (primera !== undefined) line.recent.delete(primera);
    }
    return receipt;
  }

  #construir(cmd: OutboundCommand, field: string): { metodo: string; cuerpo: Record<string, unknown> } {
    const input = cmd.input;
    const base: Record<string, unknown> = {
      chat_id: cmd.to.local,
      ...(input.replyTo
        ? { reply_parameters: { message_id: Number(input.replyTo), allow_sending_without_reply: true } }
        : {}),
      ...(input.buttons?.length
        ? {
            reply_markup: {
              inline_keyboard: input.buttons.map((b) => [{ text: b.title, callback_data: b.id }]),
            },
          }
        : {}),
    };

    const enlace = (): string => {
      const fuente = input[field as "image"];
      if (fuente && "url" in fuente) return fuente.url;
      throw new OmniError(
        "validation_failed",
        "este transporte necesita el medio como URL pública alcanzable por Telegram",
        { campo: field },
      );
    };
    const pie = input.caption ? { caption: input.caption } : {};

    switch (field) {
      case "text":
        return { metodo: "sendMessage", cuerpo: { ...base, text: input.text! } };
      case "image":
        return { metodo: "sendPhoto", cuerpo: { ...base, photo: enlace(), ...pie } };
      case "video":
        return { metodo: "sendVideo", cuerpo: { ...base, video: enlace(), ...pie } };
      case "audio":
        // `sendVoice` para las notas de voz, `sendAudio` para la música: con el
        // método equivocado el mensaje sale, pero no se parece al que se pidió.
        return input.ptt
          ? { metodo: "sendVoice", cuerpo: { ...base, voice: enlace() } }
          : { metodo: "sendAudio", cuerpo: { ...base, audio: enlace(), ...pie } };
      case "document":
        return { metodo: "sendDocument", cuerpo: { ...base, document: enlace(), ...pie } };
      case "sticker":
        return { metodo: "sendSticker", cuerpo: { ...base, sticker: enlace() } };
      case "location":
        return {
          metodo: "sendLocation",
          cuerpo: {
            ...base,
            latitude: input.location!.latitude,
            longitude: input.location!.longitude,
          },
        };
      case "contact": {
        const c = input.contact!;
        const [nombre, ...resto] = c.fullName.split(" ");
        return {
          metodo: "sendContact",
          cuerpo: {
            ...base, phone_number: c.phone, first_name: nombre ?? c.fullName,
            ...(resto.length > 0 ? { last_name: resto.join(" ") } : {}),
          },
        };
      }
      case "poll":
        return {
          metodo: "sendPoll",
          cuerpo: {
            ...base,
            question: input.poll!.question,
            options: input.poll!.options,
            allows_multiple_answers: input.poll!.allowMultipleAnswers,
            is_anonymous: true,
          },
        };
      case "buttons":
        // Los botones no son un tipo de mensaje aquí: son un adorno del texto.
        return {
          metodo: "sendMessage",
          cuerpo: { ...base, text: input.bodyText ?? input.text ?? " " },
        };
      default:
        throw new OmniError(
          "capability_unsupported",
          `Telegram no admite "${field}"`,
          { capability: `send.${field}`, channelKind: "telegram" },
        );
    }
  }

  // ---------------------------------------------------------------- opcionales

  async editMessage(
    lineId: LineId, chat: Address, providerMessageId: string, text: string,
  ): Promise<void> {
    const line = this.#require(lineId);
    await this.#llamar(line, "editMessageText", {
      chat_id: chat.local, message_id: Number(providerMessageId), text,
    });
  }

  async deleteMessage(lineId: LineId, chat: Address, providerMessageId: string): Promise<void> {
    const line = this.#require(lineId);
    await this.#llamar(line, "deleteMessage", {
      chat_id: chat.local, message_id: Number(providerMessageId),
    });
  }

  async react(
    lineId: LineId, chat: Address, providerMessageId: string, emoji: string,
  ): Promise<void> {
    const line = this.#require(lineId);
    // Una cadena vacía quita la reacción, igual que en los demás drivers.
    await this.#llamar(line, "setMessageReaction", {
      chat_id: chat.local, message_id: Number(providerMessageId),
      reaction: emoji ? [{ type: "emoji", emoji }] : [],
    });
  }

  async setPresence(
    lineId: LineId, chat: Address, presence: "composing" | "recording" | "paused",
  ): Promise<void> {
    const line = this.#require(lineId);
    // No hay "parado": Telegram caduca la acción sola a los cinco segundos.
    if (presence === "paused") return;
    await this.#llamar(line, "sendChatAction", {
      chat_id: chat.local,
      action: presence === "recording" ? "record_voice" : "typing",
    });
  }

  async groupMetadata(lineId: LineId, group: Address): Promise<GroupMetadata> {
    const line = this.#require(lineId);
    const chat = await this.#llamar<{ id: number; title?: string; description?: string }>(
      line, "getChat", { chat_id: group.local },
    );
    const cuantos = await this.#llamar<number>(line, "getChatMemberCount", { chat_id: group.local })
      .catch(() => 0);
    return {
      address: parseAddress(`${chat.id}@telegram`),
      subject: chat.title ?? "",
      ...(chat.description ? { description: chat.description } : {}),
      /*
       * La lista entera no se puede pedir: Telegram solo da los
       * administradores. Devolverla vacía es más honesto que rellenarla con
       * los administradores y hacerla pasar por completa.
       */
      participants: [],
      ...(cuantos ? { size: cuantos } : {}),
    };
  }

  // ---------------------------------------------------------------- ingesta

  /** Una vuelta de `getUpdates`. Separada para poder probarla sin bucle. */
  async pollOnce(lineId: LineId): Promise<number> {
    const line = this.#require(lineId);
    const updates = await this.#llamar<TelegramUpdate[]>(line, "getUpdates", {
      offset: line.offset, timeout: this.#pollSeconds, allowed_updates: [],
    });
    for (const u of updates) {
      // El desplazamiente avanza SIEMPRE, incluso si el manejo falla: si no,
      // una actualización que rompa el normalizado se repetiría para siempre.
      line.offset = Math.max(line.offset, u.update_id + 1);
      try {
        await this.#ingerir(lineId, line, u);
      } catch {
        // Una actualización rara no puede parar el bucle de las demás.
      }
    }
    return updates.length;
  }

  async #sondear(lineId: LineId, line: LineRuntime): Promise<void> {
    if (line.polling) return;
    line.polling = true;
    while (line.polling && line.status.state === "connected") {
      try {
        await this.pollOnce(lineId);
      } catch {
        // Un corte de red no desconecta la línea: se espera y se reintenta.
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async #ingerir(lineId: LineId, line: LineRuntime, u: TelegramUpdate): Promise<void> {
    const m = u.message ?? u.channel_post;
    if (!m) return;

    const chat = parseAddress(`${m.chat.id}@telegram`);
    const de = m.from ? parseAddress(`${m.from.id}@telegram`) : chat;
    const texto = m.text ?? m.caption ?? null;

    const payload = {
      key: { id: String(m.message_id), remoteJid: chat.value, fromMe: false },
      from: de.value,
      kind: telegramKind(m),
      text: texto,
      timestamp: m.date * 1000,
      ...(m.from?.first_name ? { pushName: m.from.first_name } : {}),
      ...(m.chat.type && m.chat.type !== "private" ? { isGroup: true } : {}),
    };
    await this.emit("message.received", line.orgId, lineId, payload);
    await this.emit("message.upsert", line.orgId, lineId, payload);
  }

  // ---------------------------------------------------------------- HTTP

  async #llamar<T>(
    line: LineRuntime, metodo: string, cuerpo: Record<string, unknown>,
  ): Promise<T> {
    const control = new AbortController();
    line.abort = control;
    const temporizador = setTimeout(() => control.abort(), this.#timeout);
    try {
      const res = await this.#fetch(`${this.#base}/bot${line.token}/${metodo}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cuerpo),
        signal: control.signal,
      });
      const texto = await res.text();
      let datos: Respuesta<T>;
      try {
        datos = JSON.parse(texto) as Respuesta<T>;
      } catch {
        throw new OmniError("upstream_failed", `Telegram respondió algo que no es JSON: ${texto.slice(0, 200)}`);
      }

      if (!datos.ok) {
        const descripcion = datos.description ?? "sin motivo";
        /*
         * Un token malo es culpa de quien configuró la línea, no de Telegram.
         * Distinguirlo evita que un error de configuración se lea como una
         * caída del proveedor y se reintente eternamente.
         */
        if (datos.error_code === 401 || datos.error_code === 403) {
          throw new OmniError("validation_failed", `Telegram rechazó la credencial: ${descripcion}`);
        }
        if (datos.error_code === 400) {
          throw new OmniError("validation_failed", `Telegram rechazó la petición: ${descripcion}`);
        }
        throw new OmniError("upstream_failed", `Telegram falló: ${descripcion}`);
      }
      return datos.result as T;
    } catch (err) {
      if (err instanceof OmniError) throw err;
      throw new OmniError("upstream_failed", `no se pudo hablar con Telegram: ${(err as Error).message}`);
    } finally {
      clearTimeout(temporizador);
      line.abort = null;
    }
  }
}

// ---------------------------------------------------------------- tipos

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number; type?: string; title?: string };
  from?: { id: number; first_name?: string; username?: string };
  photo?: unknown[];
  video?: unknown;
  voice?: unknown;
  audio?: unknown;
  document?: unknown;
  sticker?: unknown;
  location?: unknown;
  contact?: unknown;
  poll?: unknown;
}

export function telegramKind(m: TelegramMessage): string {
  if (m.photo) return "image";
  if (m.video) return "video";
  if (m.voice ?? m.audio) return "audio";
  if (m.sticker) return "sticker";
  if (m.document) return "document";
  if (m.location) return "location";
  if (m.contact) return "contact";
  if (m.poll) return "poll";
  if (m.text) return "text";
  return "unknown";
}
