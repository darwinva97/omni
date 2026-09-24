import { and, eq, sql } from "drizzle-orm";
import {
  OmniError, parseAddress, resolveContent, advanceState,
  type ChannelKind, type EventEnvelope, type LineId, type MessageKind, type SendMessageInput,
} from "@omni/shared";
import type { ChannelDriver, LineStatus, OutboundCommand } from "@omni/channels";
import { assertCapability } from "@omni/channels";
import type { JobQueue, Kv, Subscription } from "@omni/platform";
import type { Bus } from "@omni/platform";
import type { Database } from "@omni/db";
import { authStateTable, chatTable, lineTable, messageTable } from "@omni/db";
import type { WebhookDispatcher } from "@omni/core";
import { SecretBox } from "../crypto/secret-box.js";
import { SendPacer } from "../outbound/pacer.js";

export const OUTBOUND_QUEUE = "outbound";

export interface OutboundJob {
  readonly lineId: string;
  readonly orgId: string;
  readonly clientMessageId: string;
  readonly input: SendMessageInput;
  readonly kind: MessageKind;
  readonly sentByUserId: string | null;
  readonly sentByConnectorId: string | null;
}

export interface RuntimeDeps {
  readonly db: Database;
  readonly queue: JobQueue;
  readonly kv: Kv;
  readonly bus: Bus;
  readonly box: SecretBox;
  readonly dispatcher: WebhookDispatcher;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export interface SendAccepted {
  readonly clientMessageId: string;
  readonly messageId: string;
  readonly state: "queued";
}

/**
 * Runtime del motor.
 *
 * Mantiene las conexiones vivas, ingiere lo que llega y saca lo que se envía.
 * Es el único plano con ESTADO: por eso no puede ser serverless —dormir una
 * conexión equivale a un dispositivo nuevo ante WhatsApp— y por eso escala
 * repartiendo líneas entre nodos, nunca replicando la misma línea.
 */
export class EngineRuntime {
  readonly #drivers = new Map<ChannelKind, ChannelDriver>();
  readonly #unsubscribes: (() => void)[] = [];
  readonly #deps: RuntimeDeps;
  readonly #pacer: SendPacer;
  readonly #now: () => number;
  readonly #newId: () => string;
  #outboundWorker: Subscription | null = null;

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
    this.#pacer = new SendPacer(deps.kv);
    this.#now = deps.now ?? (() => Date.now());
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
  }

  registerDriver(driver: ChannelDriver): void {
    this.#drivers.set(driver.descriptor.kind, driver);
    /*
     * Todo lo que produce un driver pasa por el mismo camino de ingesta, sea
     * WhatsApp, Telegram o el sandbox. Ahí está el valor del puerto único.
     *
     * Se DEVUELVE la promesa en vez de descartarla con `void`: el emisor la
     * espera, y así dos eventos seguidos de la misma línea se ingieren y se
     * encolan en orden. Descartándola, un acuse de "leído" podía adelantar al
     * de "entregado" y el receptor del webhook los veía al revés.
     */
    this.#unsubscribes.push(driver.subscribe((e) => this.#ingest(e)));
  }

  driverFor(kind: ChannelKind): ChannelDriver {
    const d = this.#drivers.get(kind);
    if (!d) throw new OmniError("validation_failed", `no hay driver para el canal "${kind}"`, { kind });
    return d;
  }

  // ------------------------------------------------------------------ líneas

  async #line(lineId: string): Promise<typeof lineTable.$inferSelect> {
    const rows = await this.#deps.db.select().from(lineTable).where(eq(lineTable.id, lineId)).limit(1);
    const line = rows[0];
    if (!line) throw new OmniError("not_found", `la línea "${lineId}" no existe`);
    if (line.deletedAt) throw new OmniError("not_found", `la línea "${lineId}" fue borrada`);
    return line;
  }

  async connect(lineId: string): Promise<LineStatus> {
    const line = await this.#line(lineId);
    if (!line.enabled) throw new OmniError("conflict", `la línea "${lineId}" está deshabilitada`);
    const driver = this.driverFor(line.channelKind);

    const stored = await this.#deps.db
      .select().from(authStateTable).where(eq(authStateTable.lineId, lineId)).limit(1);
    const sealed = stored[0]?.sealed ?? null;

    const result = await driver.connect({
      lineId: lineId as LineId,
      credentials: sealed ? this.#deps.box.open(sealed) : null,
      saveCredentials: async (blob) => { await this.#persistCredentials(lineId, blob); },
      config: { ...(line.driverConfig ?? {}), orgId: line.orgId },
    });

    await this.#setStatus(lineId, result.status.state);
    return result.status;
  }

  async #persistCredentials(lineId: string, blob: Uint8Array): Promise<void> {
    const sealed = this.#deps.box.seal(blob);
    await this.#deps.db
      .insert(authStateTable)
      .values({ lineId, sealed, keyVersion: this.#deps.box.version })
      .onConflictDoUpdate({
        target: authStateTable.lineId,
        set: { sealed, keyVersion: this.#deps.box.version, updatedAt: new Date() },
      });
  }

  async disconnect(lineId: string): Promise<void> {
    const line = await this.#line(lineId);
    await this.driverFor(line.channelKind).disconnect(lineId as LineId);
    await this.#setStatus(lineId, "disconnected");
  }

  /** Desconecta y BORRA las credenciales: el siguiente enlace pedirá QR de nuevo. */
  async logout(lineId: string): Promise<void> {
    await this.disconnect(lineId).catch(() => {});
    await this.#deps.db.delete(authStateTable).where(eq(authStateTable.lineId, lineId));
    await this.#setStatus(lineId, "logged-out");
  }

  async status(lineId: string): Promise<LineStatus> {
    const line = await this.#line(lineId);
    return this.driverFor(line.channelKind).status(lineId as LineId);
  }

  async #setStatus(lineId: string, state: string): Promise<void> {
    await this.#deps.db
      .update(lineTable)
      .set({ status: state, statusAt: new Date(this.#now()) })
      .where(eq(lineTable.id, lineId));
  }

  // ------------------------------------------------------------------ envío

  /**
   * Acepta un envío: lo valida, comprueba la capacidad del transporte, lo
   * persiste como `queued` y lo encola. Vuelve enseguida; el envío real ocurre
   * en el trabajador, con el ritmo de la línea.
   */
  async send(
    lineId: string,
    input: SendMessageInput,
    actor: { userId?: string; connectorId?: string } = {},
  ): Promise<SendAccepted> {
    const line = await this.#line(lineId);
    const driver = this.driverFor(line.channelKind);

    const content = resolveContent(input);
    if (!content.ok) throw new OmniError("validation_failed", content.reason);

    const kind = content.field === "text" ? "text" : (content.field as MessageKind);
    // Se comprueba ANTES de aceptar: decir 422 ahora es mucho mejor que
    // encolar algo que va a fallar en silencio dentro de un minuto.
    assertCapability(driver, `send.${content.field}` as never, this.#alternativesFor(`send.${content.field}`));
    if (input.replyTo) assertCapability(driver, "send.reply");
    if (input.mentions?.length) assertCapability(driver, "send.mentions");
    if (input.viewOnce) assertCapability(driver, "send.viewOnce");

    const to = parseAddress(input.to);
    const clientMessageId = input.clientMessageId ?? this.#newId();
    const messageId = `m-${clientMessageId}`;

    /*
     * Idempotencia.
     *
     * No basta con `ON CONFLICT DO NOTHING`: la clave primaria de `message` es
     * `(id, timestamp)` porque la tabla está particionada por tiempo, así que
     * dos envíos del mismo `clientMessageId` en milisegundos distintos NO
     * colisionan y se insertarían los dos. Un reintento de red del cliente se
     * convertiría en dos mensajes para el destinatario.
     *
     * Se cierra en dos pasos: una reserva atómica en el KV gana la carrera
     * entre peticiones simultáneas, y una consulta a la tabla cubre el caso de
     * que el KV se haya perdido o caducado.
     */
    const existing = await this.#findByClientId(lineId, clientMessageId);
    if (existing) return { clientMessageId, messageId: existing, state: "queued" };

    const reserved = await this.#deps.kv.setIfAbsent(
      `idem:${lineId}:${clientMessageId}`, messageId, 7 * 24 * 3600,
    );
    if (!reserved) {
      const found = await this.#findByClientId(lineId, clientMessageId);
      return { clientMessageId, messageId: found ?? messageId, state: "queued" };
    }

    const inserted = await this.#deps.db
      .insert(messageTable)
      .values({
        id: messageId, timestamp: new Date(this.#now()), lineId, chatId: to.value,
        clientMessageId, senderAddress: line.address ?? "", fromMe: true, kind,
        body: input.text ?? input.caption ?? null, state: "queued",
        replyToId: input.replyTo ?? null, mentions: input.mentions ? [...input.mentions] : null,
        sentFromPlatform: true,
        sentByUserId: actor.userId ?? null,
        sentByConnectorId: actor.connectorId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: messageTable.id });

    if (inserted.length === 0) {
      return { clientMessageId, messageId, state: "queued" };
    }

    await this.#deps.queue.enqueue<OutboundJob>(
      OUTBOUND_QUEUE,
      {
        lineId, orgId: line.orgId, clientMessageId, input, kind,
        sentByUserId: actor.userId ?? null, sentByConnectorId: actor.connectorId ?? null,
      },
      {
        // Una partición por LÍNEA: los envíos de un número salen en orden y al
        // ritmo de ese número, sin frenar a los demás.
        partitionKey: `line:${lineId}`,
        idempotencyKey: `send:${lineId}:${clientMessageId}`,
        maxAttempts: 3,
        backoffMs: 2000,
      },
    );

    return { clientMessageId, messageId, state: "queued" };
  }

  async #findByClientId(lineId: string, clientMessageId: string): Promise<string | null> {
    const rows = await this.#deps.db
      .select({ id: messageTable.id })
      .from(messageTable)
      .where(and(eq(messageTable.lineId, lineId), eq(messageTable.clientMessageId, clientMessageId)))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  #alternativesFor(capability: string): ChannelKind[] {
    const out: ChannelKind[] = [];
    for (const [kind, d] of this.#drivers) {
      if (d.descriptor.capabilities.has(capability as never)) out.push(kind);
    }
    return out;
  }

  // ------------------------------------------------------------------ trabajadores

  start(concurrency = 8): void {
    this.#outboundWorker = this.#deps.queue.process<OutboundJob>(
      OUTBOUND_QUEUE,
      async (job) => { await this.#deliver(job); },
      {
        concurrency,
        onDead: async (payload, _ctx, error) => {
          const job = payload as OutboundJob;
          await this.#markFailed(job, error.message);
        },
      },
    );
  }

  async #deliver(job: OutboundJob): Promise<void> {
    const line = await this.#line(job.lineId);
    const driver = this.driverFor(line.channelKind);

    await this.#pacer.pace(job.lineId, line.sendRatePerMinute);

    const cmd: OutboundCommand = {
      lineId: job.lineId as LineId,
      to: parseAddress(job.input.to),
      clientMessageId: job.clientMessageId,
      kind: job.kind,
      input: job.input,
    };
    const receipt = await driver.send(cmd);

    await this.#deps.db
      .update(messageTable)
      .set({ providerMessageId: receipt.providerMessageId, state: receipt.state })
      .where(and(eq(messageTable.lineId, job.lineId), eq(messageTable.clientMessageId, job.clientMessageId)));
  }

  async #markFailed(job: OutboundJob, reason: string): Promise<void> {
    await this.#deps.db
      .update(messageTable)
      .set({ state: "failed", failureReason: reason })
      .where(and(eq(messageTable.lineId, job.lineId), eq(messageTable.clientMessageId, job.clientMessageId)));
    await this.#deps.dispatcher.dispatch({
      id: this.#newId(), event: "message.failed", orgId: job.orgId, lineId: job.lineId,
      timestamp: this.#now(), data: { clientMessageId: job.clientMessageId, reason },
    });
  }

  // ------------------------------------------------------------------ ingesta

  /**
   * Camino único de ingesta: persistir, publicar en el bus y despachar
   * webhooks. Nunca se hace una petición de red aquí dentro.
   */
  async #ingest(envelope: EventEnvelope): Promise<void> {
    try {
      if (envelope.event === "message.received") await this.#persistInbound(envelope);
      if (envelope.event === "message.receipt") await this.#applyReceipt(envelope);
      if (envelope.event === "session.connected" || envelope.event === "session.status") {
        const data = envelope.data as { state?: string };
        if (data.state) await this.#setStatus(envelope.lineId, data.state);
      }
      await this.#deps.bus.publish(`line:${envelope.lineId}`, envelope);
      await this.#deps.dispatcher.dispatch(envelope);
    } catch {
      // Un fallo ingiriendo un evento no puede tumbar la conexión de la línea.
    }
  }

  async #persistInbound(envelope: EventEnvelope): Promise<void> {
    const d = envelope.data as {
      key: { id: string; remoteJid: string; participant?: string };
      kind?: MessageKind; text?: string | null; timestamp?: number;
    };
    const chat = parseAddress(d.key.remoteJid);
    const when = new Date(d.timestamp ?? envelope.timestamp);

    await this.#deps.db
      .insert(messageTable)
      .values({
        id: `m-${envelope.lineId}-${d.key.id}`, timestamp: when,
        lineId: envelope.lineId, chatId: chat.value, providerMessageId: d.key.id,
        senderAddress: d.key.participant ?? chat.value, fromMe: false,
        kind: d.kind ?? "text", body: d.text ?? null, state: "delivered",
        raw: envelope.data as never,
      })
      .onConflictDoNothing();

    await this.#deps.db
      .insert(chatTable)
      .values({
        id: `c-${envelope.lineId}-${chat.value}`, lineId: envelope.lineId,
        address: chat.value, kind: chat.kind, lastMessageAt: when, unreadCount: 1,
      })
      .onConflictDoUpdate({
        target: [chatTable.lineId, chatTable.address],
        set: { lastMessageAt: when, unreadCount: sql`${chatTable.unreadCount} + 1` },
      });
  }

  async #applyReceipt(envelope: EventEnvelope): Promise<void> {
    const d = envelope.data as { key: { id: string }; state: string };
    const rows = await this.#deps.db
      .select({ state: messageTable.state })
      .from(messageTable)
      .where(and(eq(messageTable.lineId, envelope.lineId), eq(messageTable.providerMessageId, d.key.id)))
      .limit(1);
    const current = rows[0]?.state;
    if (!current) return;
    // Los recibos llegan desordenados; aplicarlos tal cual haría que un mensaje
    // leído volviera a "entregado".
    const next = advanceState(current, d.state as never);
    if (next === current) return;
    await this.#deps.db
      .update(messageTable).set({ state: next })
      .where(and(eq(messageTable.lineId, envelope.lineId), eq(messageTable.providerMessageId, d.key.id)));
  }

  async stop(): Promise<void> {
    await this.#outboundWorker?.stop();
    for (const off of this.#unsubscribes) off();
    this.#unsubscribes.length = 0;
  }
}
