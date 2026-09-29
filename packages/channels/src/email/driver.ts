import { createHash } from "node:crypto";
import {
  capabilitySet, OmniError, parseAddress, resolveContent,
  type Address, type ChannelDescriptor, type LineId,
} from "@omni/shared";
import {
  EventEmitterBase,
  type ChannelDriver, type ConnectRequest, type ConnectResult,
  type LineStatus, type OutboundCommand, type SendReceipt,
} from "../port.js";

/**
 * Driver de correo: SMTP para enviar, IMAP para recibir.
 *
 * Es el canal que más estira el puerto, y por eso vale la pena tenerlo: casi
 * nada de lo que da por hecho la mensajería instantánea existe aquí.
 *
 * - **No hay presencia ni acuses.** Nadie está "escribiendo" un correo para ti,
 *   y una confirmación de lectura es una cortesía opcional que casi nadie
 *   devuelve. Ninguna de las dos capacidades se declara.
 * - **El hilo no es el contacto.** Dos personas pueden tener veinte hilos
 *   abiertos. Se usa la dirección del interlocutor como conversación, que es lo
 *   que encaja con el resto del sistema, y `In-Reply-To` para responder dentro
 *   del hilo correcto.
 * - **No hay identificador que la red asigne antes de enviar.** El
 *   `Message-ID` lo pone quien envía, así que se genera de forma determinista a
 *   partir del `clientMessageId`: eso da idempotencia de verdad, incluso si el
 *   proceso se cae entre el envío y el registro.
 */

export const EMAIL_DESCRIPTOR: ChannelDescriptor = {
  kind: "email",
  network: "email",
  linkMethod: "api-key",
  risk: "official",
  // Una conexión IMAP en espera y un transporte SMTP reutilizado.
  approxMemoryMbPerLine: 8,
  capabilities: capabilitySet(
    "send.text", "send.image", "send.video", "send.audio", "send.document",
    "send.reply",
    /*
     * Lo que NO está, y por qué:
     *
     * `message.receipts` — la confirmación de lectura es opcional y casi nadie
     *   la devuelve; declararla dejaría esperando un acuse que no llega.
     * `message.edit`, `message.delete` — un correo enviado no se puede retirar.
     * `chat.presence`, `chat.typing` — nadie está escribiendo un correo "ahora".
     * `chat.read` — marcar leído es local del buzón, no del otro lado.
     * `send.reaction`, `send.buttons`, `send.list`, `send.poll`, `send.sticker`,
     *   `send.location`, `send.contact` — no existen en el correo. Un adjunto
     *   `.vcf` no es un contacto enviado: es un fichero.
     * `group.*` — una lista de correo no es un grupo con miembros que se
     *   puedan consultar ni administrar desde aquí.
     * `history.sync` — el buzón entero está disponible, pero traerlo es una
     *   importación, no una sincronización de historial; se hará aparte.
     */
  ),
};

/** Lo mínimo de nodemailer que se usa, para poder sustituirlo en pruebas. */
export interface SmtpTransport {
  sendMail(mensaje: Record<string, unknown>): Promise<{ messageId?: string; accepted?: unknown[] }>;
  verify?(): Promise<unknown>;
  close?(): void;
}

/** Lo mínimo de IMAP que se usa. */
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  on(evento: string, manejador: (...args: unknown[]) => void): void;
  getMailboxLock(nombre: string): Promise<{ release(): void }>;
  fetch(rango: string, opciones: Record<string, unknown>): AsyncIterable<ImapMessage>;
  mailboxOpen(nombre: string): Promise<{ exists: number }>;
}

export interface ImapMessage {
  uid: number;
  source?: Uint8Array;
  envelope?: {
    messageId?: string;
    date?: Date;
    subject?: string;
    from?: { address?: string; name?: string }[];
    inReplyTo?: string;
  };
}

export interface EmailLineConfig {
  readonly orgId: string;
  readonly address: string;
  readonly smtp: SmtpTransport;
  readonly imap?: ImapClient;
}

export interface EmailOptions {
  /** Construye el transporte SMTP de una línea. Inyectable para las pruebas. */
  readonly makeSmtp?: (cfg: Readonly<Record<string, unknown>>) => SmtpTransport;
  readonly makeImap?: (cfg: Readonly<Record<string, unknown>>) => ImapClient | null;
  /** Cada cuánto se revisa el buzón, en milisegundos. */
  readonly pollMs?: number;
  readonly autoPoll?: boolean;
}

interface LineRuntime {
  readonly orgId: string;
  readonly self: Address;
  readonly smtp: SmtpTransport;
  readonly imap: ImapClient | null;
  readonly buzon: string;
  status: LineStatus;
  readonly recent: Map<string, SendReceipt>;
  /** Último UID visto. Sin esto cada vuelta reingeriría el buzón entero. */
  ultimoUid: number;
  temporizador: NodeJS.Timeout | null;
}

export class EmailDriver extends EventEmitterBase implements ChannelDriver {
  readonly descriptor = EMAIL_DESCRIPTOR;
  readonly #lines = new Map<string, LineRuntime>();
  readonly #opts: EmailOptions;

  constructor(opts: EmailOptions = {}) {
    super();
    this.#opts = opts;
  }

  // ---------------------------------------------------------------- conexión

  async connect(req: ConnectRequest): Promise<ConnectResult> {
    const cfg = req.config;
    const direccion = String(cfg["address"] ?? "");
    if (!direccion.includes("@")) {
      throw new OmniError(
        "validation_failed",
        "este transporte necesita `address` con la dirección de correo de la línea",
      );
    }
    if (!this.#opts.makeSmtp) {
      throw new OmniError(
        "validation_failed",
        "no hay forma de construir el transporte SMTP; falta la configuración del despliegue",
      );
    }

    const smtp = this.#opts.makeSmtp(cfg);
    const imap = this.#opts.makeImap?.(cfg) ?? null;

    const line: LineRuntime = {
      orgId: String(cfg["orgId"] ?? ""),
      self: parseAddress(direccion),
      smtp,
      imap,
      buzon: String(cfg["mailbox"] ?? "INBOX"),
      status: { state: "connecting" },
      recent: new Map(),
      ultimoUid: Number(cfg["lastUid"] ?? 0),
      temporizador: null,
    };
    this.#lines.set(req.lineId, line);

    /*
     * Se comprueba el SMTP antes de darla por conectada.
     *
     * Sin esto, una contraseña mal puesta no se nota hasta el primer envío, que
     * puede ser horas después y en manos de otra persona.
     */
    try {
      await smtp.verify?.();
      await imap?.connect();
    } catch (err) {
      line.status = { state: "logged-out", reason: (err as Error).message };
      throw new OmniError("validation_failed", `el servidor de correo rechazó la línea: ${(err as Error).message}`);
    }

    line.status = { state: "connected", self: line.self };
    await this.emit("session.connected", line.orgId, req.lineId, { self: line.self.value });
    await this.emit("session.status", line.orgId, req.lineId, { state: "connected" });

    if (imap && (this.#opts.autoPoll ?? true)) {
      const cada = this.#opts.pollMs ?? 60000;
      line.temporizador = setInterval(() => {
        void this.pollOnce(req.lineId).catch(() => {});
      }, cada);
      line.temporizador.unref?.();
    }
    return { status: line.status };
  }

  async disconnect(lineId: LineId): Promise<void> {
    const line = this.#lines.get(lineId);
    if (!line) return;
    if (line.temporizador) clearInterval(line.temporizador);
    line.temporizador = null;
    line.smtp.close?.();
    await line.imap?.logout().catch(() => {});
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

    if (cmd.to.kind !== "email") {
      throw new OmniError(
        "validation_failed",
        `"${cmd.to.value}" no es una dirección de correo`,
        { channelKind: "email" },
      );
    }

    const input = cmd.input;
    const messageId = deterministicMessageId(cmd.clientMessageId, line.self.local);

    const adjunto = (campo: "image" | "video" | "audio" | "document"): Record<string, unknown>[] => {
      const fuente = input[campo];
      if (!fuente) return [];
      if ("url" in fuente) {
        return [{ path: fuente.url, ...(input.fileName ? { filename: input.fileName } : {}) }];
      }
      if ("base64" in fuente) {
        return [{
          content: Buffer.from(fuente.base64, "base64"),
          contentType: fuente.mimeType,
          ...(input.fileName ? { filename: input.fileName } : {}),
        }];
      }
      throw new OmniError(
        "validation_failed",
        "para el correo el medio tiene que venir como URL o como base64",
        { campo },
      );
    };

    const cuerpo = input.text ?? input.caption ?? "";
    const mensaje: Record<string, unknown> = {
      messageId,
      from: line.self.value,
      to: cmd.to.value,
      subject: input.bodyText ?? asuntoDe(cuerpo),
      text: cuerpo,
      ...(input.replyTo
        ? { inReplyTo: input.replyTo, references: [input.replyTo] }
        : {}),
      ...(resuelto.field !== "text"
        ? { attachments: adjunto(resuelto.field as "image") }
        : {}),
    };

    const res = await line.smtp.sendMail(mensaje).catch((err: unknown) => {
      throw new OmniError("upstream_failed", `el servidor SMTP rechazó el envío: ${(err as Error).message}`);
    });

    /*
     * Queda en `sent` y ahí se queda.
     *
     * Que el servidor SMTP lo acepte no significa que llegue al buzón de nadie,
     * y no hay forma de enterarse salvo por un rebote, que llega como otro
     * correo. Llamarlo `delivered` sería una promesa que no podemos cumplir.
     */
    const receipt: SendReceipt = {
      providerMessageId: res.messageId ?? messageId,
      state: "sent",
      timestamp: Date.now(),
    };
    line.recent.set(cmd.clientMessageId, receipt);
    if (line.recent.size > 2000) {
      const primera = line.recent.keys().next().value;
      if (primera !== undefined) line.recent.delete(primera);
    }
    return receipt;
  }

  // ---------------------------------------------------------------- ingesta

  /** Una revisión del buzón. Separada para poder probarla sin temporizador. */
  async pollOnce(lineId: LineId): Promise<number> {
    const line = this.#require(lineId);
    if (!line.imap) return 0;

    const cerrojo = await line.imap.getMailboxLock(line.buzon);
    let cuantos = 0;
    try {
      // Desde el siguiente al último visto: sin esto, cada vuelta volvería a
      // ingerir el buzón entero y cada correo saldría por el webhook mil veces.
      const desde = line.ultimoUid + 1;
      for await (const m of line.imap.fetch(`${desde}:*`, { envelope: true, uid: true })) {
        if (m.uid <= line.ultimoUid) continue;
        line.ultimoUid = m.uid;
        try {
          // Solo cuenta lo que de verdad entró: el propio correo devuelto se
          // salta, y decir que se ingirió sería falso.
          if (await this.#ingerir(lineId, line, m)) cuantos++;
        } catch {
          // Un correo raro no puede detener la lectura de los siguientes.
        }
      }
    } finally {
      cerrojo.release();
    }
    return cuantos;
  }

  /** `true` si el correo se ingirió; `false` si se descartó a propósito. */
  async #ingerir(lineId: LineId, line: LineRuntime, m: ImapMessage): Promise<boolean> {
    const remitente = m.envelope?.from?.[0]?.address;
    if (!remitente) return false;

    const de = parseAddress(remitente);
    // El propio correo enviado vuelve en algunos buzones; ingerirlo lo
    // duplicaría y además se lo atribuiría al destinatario.
    if (de.value === line.self.value) return false;

    const payload = {
      key: { id: m.envelope?.messageId ?? `uid-${m.uid}`, remoteJid: de.value, fromMe: false },
      from: de.value,
      kind: "text",
      text: m.envelope?.subject ?? null,
      subject: m.envelope?.subject ?? null,
      timestamp: (m.envelope?.date ?? new Date()).getTime(),
      ...(m.envelope?.from?.[0]?.name ? { pushName: m.envelope.from[0].name } : {}),
      ...(m.envelope?.inReplyTo ? { inReplyTo: m.envelope.inReplyTo } : {}),
    };
    await this.emit("message.received", line.orgId, lineId, payload);
    await this.emit("message.upsert", line.orgId, lineId, payload);
    return true;
  }
}

/**
 * `Message-ID` determinista a partir del identificador del cliente.
 *
 * En el correo lo pone quien envía, no la red. Derivarlo así da idempotencia
 * de verdad: si el proceso se cae entre enviar y registrar, el reintento
 * produce el MISMO identificador y el buzón del destinatario no recibe dos.
 */
export function deterministicMessageId(clientMessageId: string, dominioLocal: string): string {
  const dominio = dominioLocal.includes("@") ? dominioLocal.split("@")[1]! : "omni.local";
  const huella = createHash("sha256").update(clientMessageId).digest("hex").slice(0, 32);
  return `<${huella}@${dominio}>`;
}

/** Un asunto razonable cuando nadie lo dio: la primera línea, recortada. */
export function asuntoDe(texto: string): string {
  const primera = texto.split("\n")[0]?.trim() ?? "";
  if (primera.length === 0) return "(sin asunto)";
  return primera.length > 78 ? `${primera.slice(0, 75)}...` : primera;
}
