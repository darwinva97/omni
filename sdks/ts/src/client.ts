import { OmniApiError, OmniNetworkError } from "./errors.js";

/**
 * Cliente de Omni.
 *
 * Sin dependencias en tiempo de ejecución: `fetch` y `crypto` ya vienen en
 * Node y en el navegador, y una biblioteca de HTTP aquí sería peso que arrastra
 * todo el que instale esto.
 */

export interface OmniOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * Reintentos ante fallos pasajeros. Solo se reintenta lo que tiene sentido
   * reintentar: un 429 o un 502, nunca un 403.
   */
  readonly maxRetries?: number;
}

export interface Line {
  id: string; name: string; slug: string; channelKind: string;
  address: string | null; status: string; enabled: boolean; sendRatePerMinute: number;
}

export interface Capability {
  kind: string; network: string; risk: string;
  linkMethod: string; approxMemoryMbPerLine: number; capabilities: string[];
}

export interface Chat {
  address: string; kind: string; title: string | null;
  lastMessageAt: string | null; unreadCount: number;
}

export interface Message {
  id: string; providerMessageId: string | null; fromMe: boolean;
  kind: string; body: string | null; state: string; timestamp: string;
}

export interface Accepted {
  clientMessageId: string; messageId: string; state: string;
}

/** Lo que se puede enviar. Exactamente UN campo de contenido. */
export interface SendInput {
  to: string;
  clientMessageId?: string;
  text?: string;
  image?: MediaSource;
  video?: MediaSource;
  audio?: MediaSource;
  document?: MediaSource;
  sticker?: MediaSource;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contact?: { fullName: string; phone: string; organization?: string; email?: string };
  poll?: { question: string; options: string[]; allowMultipleAnswers?: boolean };
  caption?: string;
  fileName?: string;
  replyTo?: string;
  mentions?: string[];
  viewOnce?: boolean;
  ptt?: boolean;
  typingMs?: number;
}

export type MediaSource =
  | { url: string }
  | { storageKey: string }
  | { base64: string; mimeType: string };

export class OmniClient {
  readonly #base: string;
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  readonly #maxRetries: number;

  constructor(opts: OmniOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, "");
    this.#key = opts.apiKey;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeout = opts.timeoutMs ?? 30000;
    this.#maxRetries = opts.maxRetries ?? 2;
  }

  // ---------------------------------------------------------------- líneas

  listLines(): Promise<Line[]> {
    return this.#request("GET", "/v1/lines");
  }

  createLine(input: {
    name: string; slug: string; channelKind: string;
    address?: string; sendRatePerMinute?: number;
    driverConfig?: Record<string, unknown>;
  }): Promise<Line> {
    return this.#request("POST", "/v1/lines", input);
  }

  connectLine(lineId: string): Promise<{ state: string; qr?: string }> {
    return this.#request("POST", `/v1/lines/${enc(lineId)}/connect`);
  }

  lineStatus(lineId: string): Promise<{ state: string; qr?: string; self?: string }> {
    return this.#request("GET", `/v1/lines/${enc(lineId)}/status`);
  }

  disconnectLine(lineId: string): Promise<{ ok: boolean }> {
    return this.#request("POST", `/v1/lines/${enc(lineId)}/disconnect`);
  }

  capabilities(): Promise<Capability[]> {
    return this.#request("GET", "/v1/capabilities");
  }

  /** Si este transporte sabe hacer algo, antes de intentarlo. */
  async supports(channelKind: string, capability: string): Promise<boolean> {
    const todas = await this.capabilities();
    return todas.find((c) => c.kind === channelKind)?.capabilities.includes(capability) ?? false;
  }

  // ---------------------------------------------------------------- mensajes

  /**
   * Envía. Devuelve en cuanto la API acepta: el mensaje queda ENCOLADO, no
   * entregado. Repetir el mismo `clientMessageId` no duplica.
   */
  send(lineId: string, input: SendInput): Promise<Accepted> {
    return this.#request("POST", `/v1/lines/${enc(lineId)}/messages`, input);
  }

  listChats(lineId: string, opts: { limit?: number } = {}): Promise<Chat[]> {
    return this.#request("GET", `/v1/lines/${enc(lineId)}/chats`, undefined, {
      limit: opts.limit,
    });
  }

  listMessages(
    lineId: string, chat: string, opts: { limit?: number; before?: string } = {},
  ): Promise<Message[]> {
    return this.#request("GET", `/v1/lines/${enc(lineId)}/chats/${enc(chat)}/messages`, undefined, {
      limit: opts.limit, before: opts.before,
    });
  }

  /**
   * Recorre el historial completo página a página.
   *
   * Es un generador para no cargar meses de conversación en memoria a la vez:
   * quien la consume decide cuándo parar.
   */
  async *iterateMessages(
    lineId: string, chat: string, opts: { pageSize?: number } = {},
  ): AsyncGenerator<Message, void, undefined> {
    const limit = opts.pageSize ?? 100;
    let before: string | undefined;
    for (;;) {
      const pagina = await this.listMessages(lineId, chat, { limit, ...(before ? { before } : {}) });
      for (const m of pagina) yield m;
      if (pagina.length < limit) return;
      before = pagina[pagina.length - 1]!.timestamp;
    }
  }

  editMessage(lineId: string, chat: string, messageId: string, text: string): Promise<{ ok: boolean }> {
    return this.#request("PATCH", `/v1/lines/${enc(lineId)}/chats/${enc(chat)}/messages/${enc(messageId)}`, { text });
  }

  deleteMessage(lineId: string, chat: string, messageId: string): Promise<{ ok: boolean }> {
    return this.#request("DELETE", `/v1/lines/${enc(lineId)}/chats/${enc(chat)}/messages/${enc(messageId)}`);
  }

  react(lineId: string, chat: string, messageId: string, emoji: string): Promise<{ ok: boolean }> {
    return this.#request("POST", `/v1/lines/${enc(lineId)}/chats/${enc(chat)}/messages/${enc(messageId)}/reaction`, { emoji });
  }

  markRead(lineId: string, chat: string, messageIds: string[]): Promise<{ ok: boolean }> {
    return this.#request("POST", `/v1/lines/${enc(lineId)}/chats/${enc(chat)}/read`, { messageIds });
  }

  setPresence(
    lineId: string, chat: string, presence: "composing" | "recording" | "paused",
  ): Promise<{ ok: boolean }> {
    return this.#request("POST", `/v1/lines/${enc(lineId)}/chats/${enc(chat)}/presence`, { presence });
  }

  // ---------------------------------------------------------------- webhooks

  createWebhook(input: {
    url: string; events?: string[]; lineId?: string | null;
    secret?: string; filter?: Record<string, unknown> | null;
  }): Promise<{ id: string; secret: string; url: string }> {
    return this.#request("POST", "/v1/webhooks", {
      events: [], lineId: null, ...input,
    });
  }

  listDispatches(opts: { limit?: number } = {}): Promise<{
    id: string; event: string; status: string; attempt: number;
    responseStatus: number | null; error: string | null; durationMs: number | null; createdAt: string;
  }[]> {
    return this.#request("GET", "/v1/dispatches", undefined, { limit: opts.limit });
  }

  // ---------------------------------------------------------------- interno

  async #request<T>(
    method: string, path: string, body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let ultimo: unknown;
    for (let intento = 0; intento <= this.#maxRetries; intento++) {
      try {
        const res = await this.#fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.#key}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(this.#timeout),
        });

        const texto = await res.text();
        const cuerpo: unknown = texto ? JSON.parse(texto) : {};

        if (!res.ok) {
          const err = new OmniApiError(res.status, cuerpo as Record<string, unknown>);
          // Solo se reintenta lo pasajero. Repetir un 403 no lo arregla y
          // multiplica el ruido en los registros de quien lo recibe.
          if (err.retryable && intento < this.#maxRetries) {
            await espera(2 ** intento * 500);
            ultimo = err;
            continue;
          }
          throw err;
        }
        return ((cuerpo as { data?: T }).data ?? cuerpo) as T;
      } catch (err) {
        if (err instanceof OmniApiError) throw err;
        ultimo = err;
        if (intento < this.#maxRetries) {
          await espera(2 ** intento * 500);
          continue;
        }
      }
    }
    throw new OmniNetworkError(ultimo);
  }
}

const enc = encodeURIComponent;
const espera = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
