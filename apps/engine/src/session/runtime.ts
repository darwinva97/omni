import { and, eq, isNull, sql } from "drizzle-orm";
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
import { resolveMedia, type Storage } from "@omni/storage";
import { SecretBox } from "../crypto/secret-box.js";
import { SendPacer } from "../outbound/pacer.js";

export const OUTBOUND_QUEUE = "outbound";

/** Ventana de la reserva de idempotencia. Ver el comentario en `send`. */
export const IDEMPOTENCY_RESERVE_SECONDS = 120;

export interface OutboundJob {
  readonly lineId: string;
  readonly orgId: string;
  readonly clientMessageId: string;
  readonly input: SendMessageInput;
  readonly kind: MessageKind;
  readonly sentByUserId: string | null;
  readonly sentByConnectorId: string | null;
  /**
   * Clave del medio ya guardado. Va la CLAVE y no los bytes: meter un vídeo de
   * cuarenta megas en la carga de un trabajo hincha la cola, se copia en cada
   * reintento y acaba en los registros.
   */
  readonly mediaKey: string | null;
}

export interface RuntimeDeps {
  readonly db: Database;
  readonly queue: JobQueue;
  readonly kv: Kv;
  readonly bus: Bus;
  readonly box: SecretBox;
  readonly dispatcher: WebhookDispatcher;
  readonly storage: Storage;
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

  /**
   * Reanuda todas las líneas habilitadas que tengan credenciales guardadas.
   *
   * Sin esto, las credenciales cifradas no sirven de nada: sobreviven al
   * redespliegue pero nadie las usa, y cada arranque deja todas las líneas
   * muertas hasta que alguien las reconecta a mano. Es la otra mitad de la
   * promesa de "un redespliegue reconecta en vez de pedir otro QR".
   *
   * Los fallos se informan en vez de propagarse: una línea con credenciales
   * caducadas no puede impedir que arranquen las demás.
   */
  async resumeAll(): Promise<{ resumed: string[]; failed: { lineId: string; reason: string }[] }> {
    const rows = await this.#deps.db
      .select({ id: lineTable.id })
      .from(lineTable)
      .innerJoin(authStateTable, eq(authStateTable.lineId, lineTable.id))
      .where(and(eq(lineTable.enabled, true), isNull(lineTable.deletedAt)));

    const resumed: string[] = [];
    const failed: { lineId: string; reason: string }[] = [];
    for (const { id } of rows) {
      try {
        const status = await this.connect(id);
        if (status.state === "connected") resumed.push(id);
        else failed.push({ lineId: id, reason: `quedó en "${status.state}"` });
      } catch (err) {
        failed.push({ lineId: id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { resumed, failed };
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

    /*
     * La reserva es CORTA a propósito.
     *
     * Solo tiene que cubrir la ventana entre reservar e insertar, que son
     * milisegundos; la memoria a largo plazo es la propia fila del mensaje. Con
     * una reserva de días, borrar un mensaje dejaba su reserva huérfana y el
     * siguiente envío con ese mismo identificador se tragaba en silencio: ni se
     * insertaba ni se encolaba, y el cliente recibía un 202 por nada.
     */
    const reserved = await this.#deps.kv.setIfAbsent(
      `idem:${lineId}:${clientMessageId}`, messageId, IDEMPOTENCY_RESERVE_SECONDS,
    );
    if (!reserved) {
      // Otro proceso ganó la carrera. Se le da un momento para que inserte; si
      // no aparece nada, es que murió por el camino y seguimos nosotros.
      const found = await this.#waitForMessage(lineId, clientMessageId);
      if (found) return { clientMessageId, messageId: found, state: "queued" };
    }

    /*
     * El medio se resuelve y se GUARDA aquí, antes de encolar.
     *
     * Así una URL rota o un base64 inválido se contestan con un 4xx inmediato,
     * en vez de encolar algo que fallará dentro de un minuto sin que nadie mire.
     * Y el envío deja de depender de que el servidor ajeno siga en pie cuando
     * al trabajo le toque el turno.
     */
    const media = await resolveMedia(input, { orgId: line.orgId, lineId, messageId }, {
      storage: this.#deps.storage,
    });

    const inserted = await this.#deps.db
      .insert(messageTable)
      .values({
        id: messageId, timestamp: new Date(this.#now()), lineId, chatId: to.value,
        clientMessageId, senderAddress: line.address ?? "", fromMe: true, kind,
        body: input.text ?? input.caption ?? null, state: "queued",
        replyToId: input.replyTo ?? null, mentions: input.mentions ? [...input.mentions] : null,
        mediaKey: media?.storageKey ?? null,
        mediaMime: media?.mimeType ?? null,
        mediaSize: media?.size ?? null,
        mediaFileName: media?.fileName ?? null,
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
        mediaKey: media?.storageKey ?? null,
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

  /** Espera acotada a que otro proceso termine de insertar su mensaje. */
  async #waitForMessage(lineId: string, clientMessageId: string, timeoutMs = 2000): Promise<string | null> {
    const limite = this.#now() + timeoutMs;
    for (;;) {
      const found = await this.#findByClientId(lineId, clientMessageId);
      if (found) return found;
      if (this.#now() >= limite) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
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

  /**
   * Arranca el consumidor de la cola de salida.
   *
   * Con `concurrency` 0 NO consume: es el modo para cuando los trabajos los
   * atiende un proceso aparte y este solo mantiene las conexiones vivas.
   */
  start(concurrency = 8): void {
    if (concurrency <= 0) return;
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

    let media: OutboundCommand["media"];
    if (job.mediaKey) {
      const stored = await this.#deps.storage.get(job.mediaKey);
      if (!stored) {
        throw new OmniError("not_found", `el medio "${job.mediaKey}" ya no está en el almacén`);
      }
      media = {
        bytes: stored.bytes,
        mimeType: stored.mimeType,
        ...(job.input.fileName ? { fileName: job.input.fileName } : {}),
      };
    }

    const cmd: OutboundCommand = {
      lineId: job.lineId as LineId,
      to: parseAddress(job.input.to),
      clientMessageId: job.clientMessageId,
      kind: job.kind,
      input: job.input,
      ...(media ? { media } : {}),
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

  /**
   * Publica un evento originado en la API, no en un driver.
   *
   * Archivar un chat o bloquear un contacto los decide una persona desde el
   * panel, no llegan por el socket. Pasan por el mismo camino de ingesta para
   * que un webhook los reciba igual que cualquier otro: si tomaran una vía
   * distinta, suscribirse a ellos no serviría de nada.
   */
  async publish(event: EventEnvelope["event"], lineId: string, data: unknown): Promise<void> {
    const line = await this.#line(lineId);
    await this.#ingest({
      id: this.#newId(), event, orgId: line.orgId, lineId,
      timestamp: this.#now(), data,
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
      /*
       * Se publica por ORGANIZACIÓN, no por línea.
       *
       * El WebSocket filtra por línea de todos modos, y suscribirse por línea
       * significaría una suscripción al bus por cada línea abierta: con
       * Postgres eso son otras tantas conexiones `LISTEN` a la base.
       */
      await this.#deps.bus.publish(`org:${envelope.orgId}`, envelope);
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
