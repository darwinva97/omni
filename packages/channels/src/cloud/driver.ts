import { createHmac, timingSafeEqual } from "node:crypto";
import {
  capabilitySet, OmniError, parseAddress, resolveContent,
  type Address, type ChannelDescriptor, type DeliveryState,
  type LineId, type MessageKind,
} from "@omni/shared";
import {
  EventEmitterBase,
  type ChannelDriver, type ConnectRequest, type ConnectResult,
  type LineStatus, type OutboundCommand, type SendReceipt,
} from "../port.js";
import type { CloudInboundMessage, CloudSendResponse, CloudWebhookPayload } from "./types.js";

/**
 * Driver de la API oficial de WhatsApp Cloud.
 *
 * Es el transporte SIN riesgo de baneo y el único apto para entornos
 * regulados. A cambio ve mucho menos: cubre mensajería de empresa, no las
 * conversaciones por las que la gente habla de verdad.
 *
 * Dos diferencias de fondo con Baileys, y las dos moldean el diseño:
 *
 * 1. **No hay socket.** Meta empuja los mensajes a un webhook nuestro, así que
 *    no hay nada que "conectar" ni nada que mantener vivo: `connect` valida
 *    credenciales y ya. La ingesta entra por `ingestWebhook`, que llama la API.
 *
 * 2. **No ve grupos.** Ni conversaciones personales. La API de negocio solo
 *    habla con quien ha escrito a la empresa, y fuera de una ventana de 24
 *    horas solo admite plantillas aprobadas por Meta.
 */

export const CLOUD_DESCRIPTOR: ChannelDescriptor = {
  kind: "whatsapp.cloud",
  network: "whatsapp",
  // No hay QR: se pega un token permanente desde el panel de Meta.
  linkMethod: "api-key",
  risk: "official",
  // Sin socket ni sesión en memoria: el coste por línea es despreciable.
  approxMemoryMbPerLine: 1,
  capabilities: capabilitySet(
    "send.text", "send.image", "send.video", "send.audio", "send.document",
    "send.sticker", "send.location", "send.contact", "send.reaction",
    "send.template", "send.buttons", "send.list",
    "send.reply",
    "message.receipts", "chat.read", "media.decrypt",
    /*
     * Lo que NO está, y por qué:
     *
     * `group.*` — la API de negocio no ve grupos. Es la limitación que define
     *   este transporte y ocultarla haría que el usuario pidiera algo que
     *   nunca va a funcionar.
     * `send.poll` — no existe en la API oficial.
     * `send.mentions`, `send.viewOnce`, `send.forward` — tampoco.
     * `message.edit`, `message.delete` — no se pueden editar ni borrar.
     * `call.*` — no hay llamadas.
     * `chat.presence`, `chat.typing` — no hay indicador de escritura.
     * `history.sync` — no hay historial: solo llega lo que Meta empuja desde
     *   que configuras el webhook.
     * `identity.lid` — el sistema LID es del cliente no oficial.
     * `contact.profile` — la API oficial deja leer el perfil DE LA EMPRESA,
     *   que es el propio, no el de quien escribe. Estaba declarada y no había
     *   forma de cumplirla: en la API de negocio el perfil del cliente no se
     *   consulta, llega en el webhook si Meta quiere.
     */
  ),
};

interface LineRuntime {
  readonly orgId: string;
  readonly phoneNumberId: string;
  readonly accessToken: string;
  readonly apiVersion: string;
  readonly appSecret: string | null;
  status: LineStatus;
  readonly recent: Map<string, SendReceipt>;
}

export interface CloudOptions {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export class CloudDriver extends EventEmitterBase implements ChannelDriver {
  readonly descriptor = CLOUD_DESCRIPTOR;
  readonly #lines = new Map<string, LineRuntime>();
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #timeout: number;

  constructor(opts: CloudOptions = {}) {
    super();
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#base = (opts.baseUrl ?? "https://graph.facebook.com").replace(/\/+$/, "");
    this.#timeout = opts.timeoutMs ?? 20000;
  }

  // ---------------------------------------------------------------- conexión

  async connect(req: ConnectRequest): Promise<ConnectResult> {
    const cfg = req.config;
    const phoneNumberId = String(cfg["phoneNumberId"] ?? "");
    const accessToken = String(cfg["accessToken"] ?? "");

    if (!phoneNumberId || !accessToken) {
      throw new OmniError(
        "validation_failed",
        "este transporte necesita `phoneNumberId` y `accessToken` en la configuración de la línea",
        { faltan: [!phoneNumberId && "phoneNumberId", !accessToken && "accessToken"].filter(Boolean) },
      );
    }

    const line: LineRuntime = {
      orgId: String(cfg["orgId"] ?? ""),
      phoneNumberId,
      accessToken,
      apiVersion: String(cfg["apiVersion"] ?? "v21.0"),
      appSecret: cfg["appSecret"] ? String(cfg["appSecret"]) : null,
      status: { state: "connecting" },
      recent: new Map(),
    };
    this.#lines.set(req.lineId, line);

    // No hay socket que abrir: se comprueba que el token sirve y se da por
    // conectada. Si no se comprobara, el primer envío fallaría sin que nadie
    // hubiera dicho nunca que la configuración estaba mal.
    const perfil = await this.#get<{ display_phone_number?: string; verified_name?: string }>(
      line, `/${line.phoneNumberId}`, { fields: "display_phone_number,verified_name" },
    ).catch((err: unknown) => {
      line.status = { state: "logged-out", reason: (err as Error).message };
      throw err;
    });

    const self = parseAddress((perfil.display_phone_number ?? phoneNumberId).replace(/\D/g, ""));
    line.status = {
      state: "connected", self,
      ...(perfil.verified_name ? { pushName: perfil.verified_name } : {}),
    };
    await this.emit("session.connected", line.orgId, req.lineId, { self: self.value });
    await this.emit("session.status", line.orgId, req.lineId, { state: "connected" });
    return { status: line.status };
  }

  async disconnect(lineId: LineId): Promise<void> {
    const line = this.#lines.get(lineId);
    if (!line) return;
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
      throw new OmniError("line_not_connected", `la línea "${lineId}" no está conectada (${line.status.state})`);
    }
    return line;
  }

  // ---------------------------------------------------------------- envío

  async send(cmd: OutboundCommand): Promise<SendReceipt> {
    const line = this.#require(cmd.lineId);

    const yaEnviado = line.recent.get(cmd.clientMessageId);
    if (yaEnviado) return yaEnviado;

    const resuelto = resolveContent(cmd.input);
    if (!resuelto.ok) throw new OmniError("validation_failed", resuelto.reason);

    const cuerpo = this.#buildBody(cmd, resuelto.field);
    const res = await this.#post<CloudSendResponse>(line, `/${line.phoneNumberId}/messages`, cuerpo);

    const id = res.messages?.[0]?.id;
    if (!id) throw new OmniError("upstream_failed", "Meta no devolvió identificador para el mensaje");

    const receipt: SendReceipt = { providerMessageId: id, state: "sent", timestamp: Date.now() };
    line.recent.set(cmd.clientMessageId, receipt);
    if (line.recent.size > 2000) {
      const primera = line.recent.keys().next().value;
      if (primera !== undefined) line.recent.delete(primera);
    }
    return receipt;
  }

  #buildBody(cmd: OutboundCommand, field: string): Record<string, unknown> {
    const input = cmd.input;
    const base: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: cmd.to.local,
      ...(input.replyTo ? { context: { message_id: input.replyTo } } : {}),
    };

    /*
     * Los medios van por enlace y no por identificador subido.
     *
     * La alternativa es subirlos antes a `/media` y usar su id, lo que ahorra
     * que Meta descargue el fichero pero añade una llamada y un ciclo de vida
     * que gestionar. Con el medio ya guardado en nuestro almacén, dar la URL
     * firmada es más simple y no deja objetos huérfanos en Meta.
     */
    const enlace = (): { link: string } => {
      const fuente = input[field as "image"];
      if (fuente && "url" in fuente) return { link: fuente.url };
      throw new OmniError(
        "validation_failed",
        "este transporte necesita el medio como URL pública alcanzable por Meta",
        { campo: field },
      );
    };
    const pie = input.caption ? { caption: input.caption } : {};

    switch (field) {
      case "text":
        return { ...base, type: "text", text: { body: input.text!, preview_url: true } };
      case "image":
        return { ...base, type: "image", image: { ...enlace(), ...pie } };
      case "video":
        return { ...base, type: "video", video: { ...enlace(), ...pie } };
      case "audio":
        return { ...base, type: "audio", audio: enlace() };
      case "sticker":
        return { ...base, type: "sticker", sticker: enlace() };
      case "document":
        return {
          ...base, type: "document",
          document: { ...enlace(), ...pie, ...(input.fileName ? { filename: input.fileName } : {}) },
        };
      case "location":
        return {
          ...base, type: "location",
          location: {
            latitude: input.location!.latitude, longitude: input.location!.longitude,
            ...(input.location!.name ? { name: input.location!.name } : {}),
            ...(input.location!.address ? { address: input.location!.address } : {}),
          },
        };
      case "contact": {
        const c = input.contact!;
        return {
          ...base, type: "contacts",
          contacts: [{
            name: { formatted_name: c.fullName, first_name: c.fullName.split(" ")[0] },
            phones: [{ phone: c.phone, type: "CELL", wa_id: c.phone.replace(/\D/g, "") }],
            ...(c.email ? { emails: [{ email: c.email, type: "WORK" }] } : {}),
            ...(c.organization ? { org: { company: c.organization } } : {}),
          }],
        };
      }
      case "buttons": {
        /*
         * Botones de respuesta rápida. Meta permite tres como mucho y exige un
         * cuerpo de texto: un mensaje con botones y sin texto no se acepta, así
         * que se pide explícitamente en vez de mandar uno inventado.
         */
        const cuerpo = input.bodyText ?? input.text ?? input.caption;
        if (!cuerpo) {
          throw new OmniError(
            "validation_failed",
            "un mensaje con botones necesita `bodyText`: la API oficial no acepta botones sin texto",
          );
        }
        return {
          ...base, type: "interactive",
          interactive: {
            type: "button",
            body: { text: cuerpo },
            ...(input.footerText ? { footer: { text: input.footerText } } : {}),
            action: {
              buttons: input.buttons!.map((b) => ({
                type: "reply", reply: { id: b.id, title: b.title },
              })),
            },
          },
        };
      }
      case "list": {
        const cuerpo = input.bodyText ?? input.text ?? input.caption;
        if (!cuerpo) {
          throw new OmniError(
            "validation_failed",
            "una lista necesita `bodyText`: la API oficial no acepta listas sin texto",
          );
        }
        const lista = input.list!;
        return {
          ...base, type: "interactive",
          interactive: {
            type: "list",
            header: { type: "text", text: lista.title },
            body: { text: cuerpo },
            ...(input.footerText ? { footer: { text: input.footerText } } : {}),
            action: {
              button: lista.buttonText,
              sections: lista.sections.map((sec) => ({
                title: sec.title,
                rows: sec.rows.map((r) => ({
                  id: r.id, title: r.title,
                  ...(r.description ? { description: r.description } : {}),
                })),
              })),
            },
          },
        };
      }
      case "template": {
        const t = input.template!;
        /*
         * Los parámetros van por POSICIÓN, no por nombre: Meta los sustituye en
         * los `{{1}}`, `{{2}}`… en el orden en que llegan. Un componente vacío
         * hace que Meta rechace el envío entero, así que solo se incluye el que
         * tenga valores.
         */
        const texto = (valores: readonly string[]) =>
          valores.map((v) => ({ type: "text", text: v }));
        const componentes: Record<string, unknown>[] = [];
        if (t.headerParameters?.length) {
          componentes.push({ type: "header", parameters: texto(t.headerParameters) });
        }
        if (t.bodyParameters?.length) {
          componentes.push({ type: "body", parameters: texto(t.bodyParameters) });
        }
        t.buttonParameters?.forEach((v, i) => {
          componentes.push({
            type: "button", sub_type: "url", index: String(i),
            parameters: [{ type: "text", text: v }],
          });
        });
        return {
          ...base, type: "template",
          template: {
            name: t.name,
            language: { code: t.languageCode },
            ...(componentes.length > 0 ? { components: componentes } : {}),
          },
        };
      }
      default:
        throw new OmniError(
          "capability_unsupported",
          `la API oficial no admite "${field}"`,
          { capability: `send.${field}`, channelKind: "whatsapp.cloud" },
        );
    }
  }

  async react(lineId: LineId, chat: Address, providerMessageId: string, emoji: string): Promise<void> {
    const line = this.#require(lineId);
    await this.#post(line, `/${line.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to: chat.local,
      type: "reaction",
      reaction: { message_id: providerMessageId, emoji },
    });
  }

  async markRead(lineId: LineId, _chat: Address, ids: readonly string[]): Promise<void> {
    const line = this.#require(lineId);
    // Meta marca de uno en uno; no hay operación por lote.
    for (const id of ids) {
      await this.#post(line, `/${line.phoneNumberId}/messages`, {
        messaging_product: "whatsapp", status: "read", message_id: id,
      });
    }
  }

  // ---------------------------------------------------------------- ingesta

  /**
   * Verifica la firma de un webhook de Meta.
   *
   * Sin esto, cualquiera que conozca la URL puede inventarse mensajes
   * entrantes en nombre de tus clientes. Meta firma con el secreto de la app.
   */
  verifyWebhookSignature(lineId: string, rawBody: string, header: string | undefined): boolean {
    const line = this.#lines.get(lineId);
    if (!line?.appSecret) return false;
    if (!header?.startsWith("sha256=")) return false;
    const esperado = createHmac("sha256", line.appSecret).update(rawBody, "utf8").digest("hex");
    const a = Buffer.from(header.slice(7), "utf8");
    const b = Buffer.from(esperado, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Procesa un `POST` de Meta. Lo llama la ruta HTTP, no un socket: es la
   * diferencia de fondo con los transportes no oficiales.
   */
  async ingestWebhook(lineId: string, payload: CloudWebhookPayload): Promise<number> {
    const line = this.#lines.get(lineId);
    if (!line) throw new OmniError("not_found", `la línea "${lineId}" no está registrada`);

    let procesados = 0;
    for (const entry of payload.entry ?? []) {
      for (const cambio of entry.changes ?? []) {
        const valor = cambio.value;
        const nombres = new Map((valor.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));

        for (const mensaje of valor.messages ?? []) {
          await this.#emitInbound(lineId, line, mensaje, nombres.get(mensaje.from));
          procesados++;
        }

        for (const estado of valor.statuses ?? []) {
          const traducido = statusToState(estado.status);
          if (!traducido) continue;
          await this.emit("message.receipt", line.orgId, lineId, {
            key: { id: estado.id, remoteJid: `${estado.recipient_id}@s.whatsapp.net`, fromMe: true },
            state: traducido,
            ...(estado.errors?.length ? { error: estado.errors[0]!.message } : {}),
          });
          procesados++;
        }
      }
    }
    return procesados;
  }

  async #emitInbound(
    lineId: string, line: LineRuntime, m: CloudInboundMessage, pushName?: string,
  ): Promise<void> {
    const chat = parseAddress(m.from);

    if (m.type === "reaction" && m.reaction) {
      await this.emit("message.reaction", line.orgId, lineId, {
        key: { id: m.reaction.message_id, remoteJid: chat.value, fromMe: false },
        emoji: m.reaction.emoji,
      });
      return;
    }

    const payload = {
      key: { id: m.id, remoteJid: chat.value, fromMe: false },
      pushName: pushName ?? null,
      kind: cloudKind(m.type),
      text: cloudText(m),
      // Meta da el instante en SEGUNDOS; tratarlo como milisegundos sitúa el
      // mensaje en 1970 y descoloca todo el orden de la conversación.
      timestamp: Number(m.timestamp) * 1000,
      raw: m,
    };
    await this.emit("message.received", line.orgId, lineId, payload);
    await this.emit("message.upsert", line.orgId, lineId, payload);
  }

  // ---------------------------------------------------------------- HTTP

  async #post<T>(line: LineRuntime, path: string, body: unknown): Promise<T> {
    return this.#call<T>(line, path, { method: "POST", body: JSON.stringify(body) });
  }

  async #get<T>(line: LineRuntime, path: string, query: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams(query).toString();
    return this.#call<T>(line, `${path}${qs ? `?${qs}` : ""}`, { method: "GET" });
  }

  async #call<T>(line: LineRuntime, path: string, init: RequestInit): Promise<T> {
    const url = `${this.#base}/${line.apiVersion}${path}`;
    let res: Response;
    try {
      res = await this.#fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${line.accessToken}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (err) {
      throw new OmniError("upstream_failed", `no se pudo hablar con Meta: ${(err as Error).message}`);
    }

    const texto = await res.text();
    const cuerpo: unknown = texto ? JSON.parse(texto) : {};

    if (!res.ok) {
      const e = (cuerpo as { error?: { message?: string; code?: number } }).error;
      // El mensaje de Meta es lo único accionable; "HTTP 400" no dice nada.
      throw new OmniError(
        res.status === 401 || res.status === 403 ? "unauthenticated" : "upstream_failed",
        e?.message ?? `Meta respondió ${res.status}`,
        { metaCode: e?.code ?? null, httpStatus: res.status },
      );
    }
    return cuerpo as T;
  }
}

// ---------------------------------------------------------------- utilidades

export function statusToState(status: string): DeliveryState | null {
  switch (status) {
    case "sent": return "sent";
    case "delivered": return "delivered";
    case "read": return "read";
    case "failed": return "failed";
    default: return null;
  }
}

export function cloudKind(type: string): MessageKind {
  switch (type) {
    case "text": return "text";
    case "image": return "image";
    case "video": return "video";
    case "audio": return "audio";
    case "document": return "document";
    case "sticker": return "sticker";
    case "location": return "location";
    case "contacts": return "contact";
    case "reaction": return "reaction";
    case "system": return "system";
    default: return "unknown";
  }
}

/** El texto vive en `text.body` o en el pie del medio, según el tipo. */
export function cloudText(m: CloudInboundMessage): string | null {
  return m.text?.body ?? m.image?.caption ?? m.video?.caption ?? m.document?.caption ?? null;
}
