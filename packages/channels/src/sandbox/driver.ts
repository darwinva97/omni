import {
  capabilitySet, parseAddress, OmniError,
  type Address, type ChannelDescriptor, type DeliveryState,
  type LineId, type MessageKind,
} from "@omni/shared";
import {
  EventEmitterBase,
  type ChannelDriver, type ConnectRequest, type ConnectResult,
  type GroupMetadata, type LineStatus, type OutboundCommand, type SendReceipt,
} from "../port.js";

/**
 * SANDBOX: un WhatsApp falso.
 *
 * Implementa el puerto entero —las mismas rutas, el mismo código aguas arriba—
 * contra una red simulada en memoria. Existe para que se pueda desarrollar,
 * probar e integrar en CI sin un teléfono, sin esperar a Baileys y sin exponer
 * un número real al riesgo de baneo.
 *
 * Es determinista a propósito: reloj e identificadores inyectables, para que un
 * test afirme tiempos y `id`s exactos en vez de conformarse con "algo pasó".
 */

export interface SandboxOptions {
  readonly now?: () => number;
  readonly nextId?: () => string;
  /** Milisegundos simulados entre `sent` → `delivered` → `read`. 0 = inmediato. */
  readonly ackDelayMs?: number;
  /** Si es `false`, los envíos no progresan solos y el test controla los acuses. */
  readonly autoAck?: boolean;
}

export interface SandboxMessage {
  readonly id: string;
  readonly chat: string;
  readonly from: string;
  readonly fromMe: boolean;
  readonly kind: MessageKind;
  readonly text: string | null;
  readonly timestamp: number;
  state: DeliveryState;
}

interface LineState {
  status: LineStatus;
  orgId: string;
  readonly thread: SandboxMessage[];
  readonly groups: Map<string, GroupMetadata>;
  readonly known: Set<string>;
  pendingQr: string | null;
}

export const SANDBOX_DESCRIPTOR: ChannelDescriptor = {
  kind: "sandbox",
  network: "sandbox",
  linkMethod: "qr",
  risk: "simulated",
  approxMemoryMbPerLine: 1,
  // El sandbox soporta TODO a propósito: así la batería de contrato ejercita
  // cada capacidad y sirve de referencia de comportamiento para los demás drivers.
  capabilities: capabilitySet(
    "send.text", "send.image", "send.video", "send.audio", "send.document",
    "send.sticker", "send.location", "send.contact", "send.poll",
    "send.reaction", "send.buttons", "send.list", "send.template",
    "send.reply", "send.mentions", "send.viewOnce", "send.forward",
    "message.edit", "message.delete", "message.receipts",
    "chat.read", "chat.presence", "chat.typing", "chat.archive", "chat.mute", "chat.ephemeral",
    "group.read", "group.create", "group.manage", "group.invite", "group.participants",
    "contact.check", "contact.block", "contact.profile", "identity.lid",
    "call.receive", "call.reject",
    "label.manage", "newsletter.read", "newsletter.send", "history.sync", "media.decrypt",
  ),
};

export class SandboxDriver extends EventEmitterBase implements ChannelDriver {
  readonly descriptor = SANDBOX_DESCRIPTOR;
  readonly #lines = new Map<string, LineState>();
  readonly #now: () => number;
  readonly #nextId: () => string;
  readonly #ackDelayMs: number;
  readonly #autoAck: boolean;
  #seq = 0;

  constructor(opts: SandboxOptions = {}) {
    super();
    this.#now = opts.now ?? (() => Date.now());
    this.#nextId = opts.nextId ?? (() => `SBX${(++this.#seq).toString().padStart(6, "0")}`);
    this.#ackDelayMs = opts.ackDelayMs ?? 0;
    this.#autoAck = opts.autoAck ?? true;
  }

  // ---------------------------------------------------------------- ciclo de vida

  async connect(req: ConnectRequest): Promise<ConnectResult> {
    const orgId = String(req.config["orgId"] ?? "sandbox-org");
    const existing = this.#lines.get(req.lineId);
    const line: LineState = existing ?? {
      status: { state: "connecting" },
      orgId,
      thread: [],
      groups: new Map(),
      known: new Set(),
      pendingQr: null,
    };
    this.#lines.set(req.lineId, line);
    line.orgId = orgId;

    // Con credenciales previas reconecta sin volver a pedir el QR. Es justo lo
    // que un gateway real debe hacer en un redespliegue y lo que `wapi` no hacía.
    if (req.credentials && req.credentials.byteLength > 0) {
      const self = parseAddress(new TextDecoder().decode(req.credentials));
      line.status = { state: "connected", self, pushName: "Sandbox" };
      await this.emit("session.connected", line.orgId, req.lineId, { self: self.value });
      await this.emit("session.status", line.orgId, req.lineId, { state: "connected" });
      return { status: line.status };
    }

    const qr = `SANDBOX-QR-${req.lineId}-${this.#nextId()}`;
    line.pendingQr = qr;
    line.status = { state: "awaiting-link", qr };
    await this.emit("session.qr", line.orgId, req.lineId, { qr });
    await this.emit("session.status", line.orgId, req.lineId, { state: "awaiting-link" });
    return { status: line.status };
  }

  async disconnect(lineId: LineId): Promise<void> {
    const line = this.#require(lineId);
    line.status = { state: "disconnected" };
    await this.emit("session.disconnected", line.orgId, lineId, { reason: "requested" });
  }

  status(lineId: LineId): LineStatus {
    return this.#lines.get(lineId)?.status ?? { state: "disconnected" };
  }

  // ---------------------------------------------------------------- API del sandbox

  /**
   * Completa el enlace: el equivalente a escanear el QR con el teléfono, pero
   * por API, que es lo que permite correr esto en CI sin intervención humana.
   */
  async scan(lineId: LineId, phone: string, credentialSink?: (b: Uint8Array) => Promise<void>): Promise<LineStatus> {
    const line = this.#require(lineId);
    if (line.status.state !== "awaiting-link") {
      throw new OmniError("conflict", `la línea no espera enlace (está en "${line.status.state}")`);
    }
    const self = parseAddress(phone);
    line.pendingQr = null;
    line.status = { state: "connected", self, pushName: "Sandbox" };
    await credentialSink?.(new TextEncoder().encode(self.value));
    await this.emit("session.connected", line.orgId, lineId, { self: self.value });
    await this.emit("session.status", line.orgId, lineId, { state: "connected" });
    return line.status;
  }

  /**
   * Fabrica un mensaje ENTRANTE de un contacto que no existe. Es lo que hace
   * que un manejador de webhooks real se pueda probar de punta a punta: el
   * evento que sale de aquí es idéntico al de una línea de verdad.
   */
  async inbound(
    lineId: LineId,
    from: string,
    text: string,
    opts: { kind?: MessageKind; chat?: string; pushName?: string } = {},
  ): Promise<SandboxMessage> {
    const line = this.#require(lineId);
    this.#requireConnected(line, lineId);

    const sender = parseAddress(from);
    const chat = opts.chat ? parseAddress(opts.chat) : sender;
    const msg: SandboxMessage = {
      id: this.#nextId(),
      chat: chat.value,
      from: sender.value,
      fromMe: false,
      kind: opts.kind ?? "text",
      text,
      timestamp: this.#now(),
      state: "delivered",
    };
    line.thread.push(msg);
    line.known.add(sender.value);

    const payload = {
      key: { id: msg.id, remoteJid: chat.value, fromMe: false, participant: chat.kind === "group" ? sender.value : undefined },
      pushName: opts.pushName ?? "Sandbox Contact",
      kind: msg.kind,
      text,
      timestamp: msg.timestamp,
    };
    await this.emit("message.received", line.orgId, lineId, payload);
    await this.emit("message.upsert", line.orgId, lineId, payload);
    return msg;
  }

  /** Vista de la conversación, en ambos sentidos. Para aserciones en tests. */
  thread(lineId: LineId, chat?: string): readonly SandboxMessage[] {
    const line = this.#require(lineId);
    if (!chat) return [...line.thread];
    const target = parseAddress(chat).value;
    return line.thread.filter((m) => m.chat === target);
  }

  /** Simula una llamada entrante, para ejercitar `call.received` y el rechazo. */
  async incomingCall(lineId: LineId, from: string): Promise<string> {
    const line = this.#require(lineId);
    this.#requireConnected(line, lineId);
    const callId = this.#nextId();
    await this.emit("call.received", line.orgId, lineId, {
      callId, from: parseAddress(from).value, timestamp: this.#now(),
    });
    return callId;
  }

  reset(): void {
    this.#lines.clear();
    this.#seq = 0;
  }

  // ---------------------------------------------------------------- envío

  async send(cmd: OutboundCommand): Promise<SendReceipt> {
    const line = this.#require(cmd.lineId);
    this.#requireConnected(line, cmd.lineId);

    // Idempotencia: la misma orden dos veces es UNA. El reintento de red de un
    // cliente no puede convertirse en dos mensajes para el destinatario.
    const seen = line.thread.find((m) => m.fromMe && m.id === this.#idFor(cmd.clientMessageId));
    if (seen) return { providerMessageId: seen.id, state: seen.state, timestamp: seen.timestamp };

    const msg: SandboxMessage = {
      id: this.#idFor(cmd.clientMessageId),
      chat: cmd.to.value,
      from: this.#selfOf(line),
      fromMe: true,
      kind: cmd.kind,
      text: cmd.input.text ?? cmd.input.caption ?? null,
      timestamp: this.#now(),
      state: "sent",
    };
    line.thread.push(msg);

    const payload = {
      key: { id: msg.id, remoteJid: msg.chat, fromMe: true },
      kind: msg.kind, text: msg.text, timestamp: msg.timestamp,
    };
    await this.emit("message.sent", line.orgId, cmd.lineId, payload);
    await this.emit("message.upsert", line.orgId, cmd.lineId, payload);

    if (this.#autoAck) await this.#progressAcks(cmd.lineId, line, msg);
    return { providerMessageId: msg.id, state: msg.state, timestamp: msg.timestamp };
  }

  /** Empuja a mano el acuse de un mensaje, cuando `autoAck` está apagado. */
  async ack(lineId: LineId, providerMessageId: string, state: DeliveryState): Promise<void> {
    const line = this.#require(lineId);
    const msg = line.thread.find((m) => m.id === providerMessageId);
    if (!msg) throw new OmniError("not_found", `mensaje "${providerMessageId}" no está en el hilo`);
    msg.state = state;
    await this.emit("message.receipt", line.orgId, lineId, {
      key: { id: msg.id, remoteJid: msg.chat, fromMe: msg.fromMe }, state,
    });
  }

  async #progressAcks(lineId: LineId, line: LineState, msg: SandboxMessage): Promise<void> {
    const steps: DeliveryState[] = ["delivered", "read"];
    for (const state of steps) {
      if (this.#ackDelayMs > 0) await new Promise((r) => setTimeout(r, this.#ackDelayMs));
      msg.state = state;
      await this.emit("message.receipt", line.orgId, lineId, {
        key: { id: msg.id, remoteJid: msg.chat, fromMe: true }, state,
      });
    }
  }

  // ---------------------------------------------------------------- opcionales

  async editMessage(lineId: LineId, _chat: Address, providerMessageId: string, text: string): Promise<void> {
    const line = this.#require(lineId);
    const msg = line.thread.find((m) => m.id === providerMessageId);
    if (!msg) throw new OmniError("not_found", `mensaje "${providerMessageId}" no encontrado`);
    (msg as { text: string | null }).text = text;
    await this.emit("message.updated", line.orgId, lineId, {
      key: { id: msg.id, remoteJid: msg.chat, fromMe: msg.fromMe }, text,
    });
  }

  async deleteMessage(lineId: LineId, _chat: Address, providerMessageId: string): Promise<void> {
    const line = this.#require(lineId);
    const i = line.thread.findIndex((m) => m.id === providerMessageId);
    if (i === -1) throw new OmniError("not_found", `mensaje "${providerMessageId}" no encontrado`);
    const [msg] = line.thread.splice(i, 1);
    await this.emit("message.deleted", line.orgId, lineId, {
      key: { id: msg!.id, remoteJid: msg!.chat, fromMe: msg!.fromMe },
    });
  }

  async react(lineId: LineId, chat: Address, providerMessageId: string, emoji: string): Promise<void> {
    const line = this.#require(lineId);
    await this.emit("message.reaction", line.orgId, lineId, {
      key: { id: providerMessageId, remoteJid: chat.value }, emoji,
    });
  }

  async markRead(lineId: LineId, chat: Address, ids: readonly string[]): Promise<void> {
    const line = this.#require(lineId);
    await this.emit("chat.read", line.orgId, lineId, { chat: chat.value, messageIds: [...ids] });
  }

  async setPresence(lineId: LineId, chat: Address, presence: "composing" | "recording" | "paused"): Promise<void> {
    const line = this.#require(lineId);
    await this.emit("presence.updated", line.orgId, lineId, { chat: chat.value, presence });
  }

  async checkContact(lineId: LineId, address: Address): Promise<{ exists: boolean; address: Address | null }> {
    const line = this.#require(lineId);
    // En el sandbox "existe" quien ya ha aparecido en el hilo. Determinista.
    const exists = line.known.has(address.value) || address.local.startsWith("5199");
    return { exists, address: exists ? address : null };
  }

  async groupMetadata(lineId: LineId, group: Address): Promise<GroupMetadata> {
    const line = this.#require(lineId);
    const found = line.groups.get(group.value);
    if (!found) throw new OmniError("not_found", `grupo "${group.value}" no existe en el sandbox`);
    return found;
  }

  async listGroups(lineId: LineId): Promise<readonly GroupMetadata[]> {
    return [...this.#require(lineId).groups.values()];
  }

  /** Alta de grupo simulada, para ejercitar la API de grupos sin un WhatsApp real. */
  async createGroup(lineId: LineId, subject: string, participants: readonly string[]): Promise<GroupMetadata> {
    const line = this.#require(lineId);
    this.#requireConnected(line, lineId);
    const address = parseAddress(`${this.#nextId()}-${this.#now()}@g.us`);
    const meta: GroupMetadata = {
      address, subject,
      owner: parseAddress(this.#selfOf(line)),
      participants: [
        { address: parseAddress(this.#selfOf(line)), role: "superadmin" as const },
        ...participants.map((p) => ({ address: parseAddress(p), role: "member" as const })),
      ],
      createdAt: this.#now(),
    };
    line.groups.set(address.value, meta);
    await this.emit("group.created", line.orgId, lineId, { group: address.value, subject });
    return meta;
  }

  async updateParticipants(
    lineId: LineId, group: Address, participants: readonly Address[],
    action: "add" | "remove" | "promote" | "demote",
  ): Promise<readonly { address: Address; ok: boolean; reason?: string }[]> {
    const line = this.#require(lineId);
    const meta = line.groups.get(group.value);
    if (!meta) throw new OmniError("not_found", `grupo "${group.value}" no existe en el sandbox`);

    const current = new Map(meta.participants.map((p) => [p.address.value, p]));
    const results = participants.map((address) => {
      if (action === "add") {
        if (current.has(address.value)) return { address, ok: false, reason: "ya es miembro" };
        current.set(address.value, { address, role: "member" as const });
        return { address, ok: true };
      }
      const existing = current.get(address.value);
      if (!existing) return { address, ok: false, reason: "no es miembro" };
      if (action === "remove") current.delete(address.value);
      else current.set(address.value, { address, role: action === "promote" ? "admin" : "member" });
      return { address, ok: true };
    });

    line.groups.set(group.value, { ...meta, participants: [...current.values()] });
    await this.emit("group.participants", line.orgId, lineId, {
      group: group.value, action,
      participants: results.filter((r) => r.ok).map((r) => r.address.value),
    });
    return results;
  }

  async rejectCall(lineId: LineId, callId: string, from: Address): Promise<void> {
    const line = this.#require(lineId);
    await this.emit("call.updated", line.orgId, lineId, { callId, from: from.value, status: "rejected" });
  }

  async fetchHistory(lineId: LineId, chat: Address, before: number, count: number): Promise<void> {
    const line = this.#require(lineId);
    const older = line.thread.filter((m) => m.chat === chat.value && m.timestamp < before).slice(-count);
    await this.emit("history.synced", line.orgId, lineId, { chat: chat.value, count: older.length });
  }

  // ---------------------------------------------------------------- interno

  #idFor(clientMessageId: string): string {
    return `SBX-${clientMessageId}`;
  }

  #selfOf(line: LineState): string {
    return line.status.state === "connected" ? line.status.self.value : "0@s.whatsapp.net";
  }

  #require(lineId: string): LineState {
    const line = this.#lines.get(lineId);
    if (!line) throw new OmniError("not_found", `la línea "${lineId}" no existe en el sandbox`);
    return line;
  }

  #requireConnected(line: LineState, lineId: string): void {
    if (line.status.state !== "connected") {
      throw new OmniError("line_not_connected", `la línea "${lineId}" no está conectada (${line.status.state})`);
    }
  }
}
