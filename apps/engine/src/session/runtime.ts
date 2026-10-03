import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  OmniError, parseAddress, tryParseAddress, resolveContent, advanceState,
  type Address, type ChannelKind, type EventEnvelope, type LineId, type MessageKind,
  type SendMessageInput,
} from "@omni/shared";
import type { ChannelDriver, LineStatus, OutboundCommand } from "@omni/channels";
import { assertCapability } from "@omni/channels";
import type { JobQueue, Kv, Subscription } from "@omni/platform";
import type { Bus } from "@omni/platform";
import type { Database } from "@omni/db";
import { authStateTable, chatTable, contactTable, groupInfoTable, identityMapTable, lineTable, messageTable } from "@omni/db";
import type { WebhookDispatcher } from "@omni/core";
import { mediaKey, resolveMedia, type Storage } from "@omni/storage";
import { SecretBox } from "../crypto/secret-box.js";
import { SendPacer } from "../outbound/pacer.js";

export const OUTBOUND_QUEUE = "outbound";

/**
 * Los medios entrantes se descargan en su propia cola.
 *
 * WhatsApp no manda el fichero: manda una referencia cifrada que solo el
 * cliente enlazado resuelve y que CADUCA. Hacerlo dentro de la ingesta ataría
 * la llegada del mensaje a la descarga de un adjunto de veinte megas; hacerlo
 * en una cola deja el mensaje disponible al instante, reintenta si falla y
 * manda a la cola muerta lo que no se pueda, donde se ve.
 */
export const INBOUND_MEDIA_QUEUE = "inbound-media";

export interface InboundMediaJob {
  readonly lineId: string;
  readonly orgId: string;
  readonly messageId: string;
  readonly providerMessageId: string;
  readonly timestamp: number;
  readonly raw: unknown;
}

/** Los tipos de mensaje que llevan fichero detrás. */
const MEDIA_KINDS = new Set(["image", "video", "audio", "document", "sticker"]);

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
  #mediaWorker: Subscription | null = null;
  readonly #oyentes: ((e: EventEnvelope) => Promise<void> | void)[] = [];

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
    this.#pacer = new SendPacer(deps.kv);
    this.#now = deps.now ?? (() => Date.now());
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Se avisa a estos DESPUÉS de persistir, publicar y despachar webhooks.
   *
   * El orden importa: lo que ya estaba garantizado no puede esperar a un
   * oyente lento. Un fallo aquí tampoco puede tumbar la ingesta.
   */
  onEvent(oyente: (e: EventEnvelope) => Promise<void> | void): void {
    this.#oyentes.push(oyente);
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
    /*
     * `typingMs` pide simular escritura antes de enviar. Donde no hay
     * indicador de escritura no se puede: aceptarlo y no hacerlo dejaría a
     * quien lo pidió creyendo que su mensaje sale con pausa cuando sale seco.
     */
    if (input.typingMs && input.typingMs > 0) assertCapability(driver, "chat.typing");

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

  /**
   * Reintenta un mensaje que falló, sin crear otro.
   *
   * Se reconstruye la orden desde la fila guardada y se reencola con el MISMO
   * `clientMessageId`: así, si el envío anterior llegó a salir sin que nos
   * enteráramos, la idempotencia del transporte lo detiene y el destinatario
   * no recibe dos copias. Solo vale para los que fallaron: reintentar uno
   * entregado sería mandarlo otra vez.
   */
  async resend(lineId: string, messageId: string): Promise<{ clientMessageId: string }> {
    const line = await this.#line(lineId);
    const filas = await this.#deps.db
      .select()
      .from(messageTable)
      .where(and(eq(messageTable.lineId, lineId), eq(messageTable.id, messageId)))
      .limit(1);
    const fila = filas[0];
    if (!fila) throw new OmniError("not_found", `el mensaje "${messageId}" no existe en esta línea`);
    if (!fila.fromMe) {
      throw new OmniError("validation_failed", "solo se pueden reintentar los mensajes que enviamos");
    }
    if (fila.state !== "failed") {
      throw new OmniError(
        "conflict",
        `ese mensaje está en "${fila.state}", no en "failed"; reintentarlo lo enviaría dos veces`,
      );
    }

    const input: SendMessageInput = {
      to: fila.chatId,
      clientMessageId: fila.clientMessageId ?? messageId,
      ...(fila.body ? { text: fila.body } : {}),
      ...(fila.replyToId ? { replyTo: fila.replyToId } : {}),
      ...(fila.mentions ? { mentions: fila.mentions } : {}),
      ...(fila.mediaFileName ? { fileName: fila.mediaFileName } : {}),
    };

    await this.#deps.db
      .update(messageTable)
      .set({ state: "queued", failureReason: null })
      .where(and(eq(messageTable.lineId, lineId), eq(messageTable.id, messageId)));

    await this.#deps.queue.enqueue<OutboundJob>(
      OUTBOUND_QUEUE,
      {
        lineId, orgId: line.orgId,
        clientMessageId: input.clientMessageId!,
        input, kind: fila.kind as MessageKind,
        sentByUserId: fila.sentByUserId ?? null,
        sentByConnectorId: fila.sentByConnectorId ?? null,
        mediaKey: fila.mediaKey ?? null,
      },
      {
        partitionKey: `line:${lineId}`,
        idempotencyKey: `send:${lineId}:${input.clientMessageId!}`,
        maxAttempts: 3,
        backoffMs: 2000,
      },
    );
    return { clientMessageId: input.clientMessageId! };
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
    this.#mediaWorker = this.#deps.queue.process<InboundMediaJob>(
      INBOUND_MEDIA_QUEUE,
      async (job) => { await this.#descargarMedio(job); },
      {
        // Menos paralelismo que el envío: son ficheros, no mensajes, y
        // saturar la red de subida de la línea perjudica a los envíos.
        concurrency: Math.max(1, Math.floor(concurrency / 2)),
        onDead: async (payload, _ctx, error) => {
          const job = payload as InboundMediaJob;
          // El mensaje se queda sin fichero, pero con el motivo escrito: un
          // adjunto que no llega y no deja rastro es imposible de diagnosticar.
          await this.#deps.db
            .update(messageTable)
            .set({ failureReason: `no se pudo traer el medio: ${error.message}` })
            .where(and(
              eq(messageTable.lineId, job.lineId),
              eq(messageTable.providerMessageId, job.providerMessageId),
            ));
        },
      },
    );
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
      // El mapeo LID↔teléfono se aprende ANTES de persistir: si el mensaje se
      // guarda primero y aquí falla algo, el chat queda con un LID que ya no
      // se puede atar a nadie, porque el servidor solo lo dice esta vez.
      await this.#aprenderIdentidad(envelope);
      if (envelope.event === "message.received") await this.#persistInbound(envelope);
      /*
       * Los nombres se aprenden DESPUÉS de persistir.
       *
       * El título vive en la fila de la conversación, y esa fila la crea
       * `#persistInbound`: hacerlo antes dejaba el primer mensaje de cada
       * conversación nueva sin nombre, que es justo el que lo trae.
       */
      await this.#aprenderNombre(envelope);
      if (envelope.event === "message.receipt") await this.#applyReceipt(envelope);
      if (envelope.event === "session.connected" || envelope.event === "session.status") {
        const data = envelope.data as { state?: string; self?: string };
        if (data.state) await this.#setStatus(envelope.lineId, data.state);
        /*
         * La dirección propia venía en el evento y se tiraba. Sin ella la
         * línea no sabe qué número es, y el panel no puede decir con qué
         * cuenta está hablando.
         */
        /*
         * Al conectar se traen los nombres de los grupos.
         *
         * Los que ya existían antes del enlace no generan ningún anuncio, así
         * que sin esto se quedan como "Grupo sin nombre" para siempre: solo
         * aprenderían su nombre si alguien escribiera en ellos, y un grupo
         * silencioso no se identifica nunca.
         *
         * Va en segundo plano a propósito. Nada de lo que viene detrás depende
         * de ello, y una cuenta con cien grupos tardaría lo suyo en responder;
         * bloquear la ingesta por los nombres retrasaría los mensajes.
         */
        if (envelope.event === "session.connected") {
          void this.sincronizarGrupos(envelope.lineId).catch(() => {});
        }
        if (data.self) {
          const propia = tryParseAddress(data.self);
          if (propia) {
            await this.#deps.db
              .update(lineTable)
              .set({ address: propia.value })
              .where(and(eq(lineTable.id, envelope.lineId), isNull(lineTable.address)));
          }
        }
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

      for (const oyente of this.#oyentes) {
        try {
          await oyente(envelope);
        } catch {
          // Un oyente roto no puede impedir que lleguen los siguientes eventos.
        }
      }
    } catch {
      // Un fallo ingiriendo un evento no puede tumbar la conexión de la línea.
    }
  }

  /**
   * Aprende el mapeo LID↔teléfono de lo que venga en el evento.
   *
   * Baileys 7 direcciona con `@lid` de forma habitual y adjunta el teléfono en
   * `remoteJidAlt`/`participantAlt` cuando WhatsApp lo da. Es la ÚNICA vez que
   * lo dice: si no se guarda aquí, ese LID no se puede resolver nunca más, y
   * como `sameAddress` no cruza tipos a propósito, la conversación queda
   * separada para siempre de la persona que hay detrás.
   */
  async #aprenderIdentidad(envelope: EventEnvelope): Promise<void> {
    const d = envelope.data as {
      key?: {
        remoteJid?: string; remoteJidAlt?: string;
        participant?: string; participantAlt?: string;
      };
    };
    if (!d.key) return;

    const pares: { lid: string; phone: string }[] = [];
    const anota = (lid?: string, phone?: string): void => {
      if (!lid || !phone) return;
      const a = tryParseAddress(lid);
      const b = tryParseAddress(phone);
      // Solo el par que de verdad es (LID, teléfono). WhatsApp a veces manda
      // los dos campos con la misma forma, y guardar eso ensuciaría la tabla.
      if (a?.kind === "lid" && b?.kind === "pn") pares.push({ lid: a.value, phone: b.value });
    };
    anota(d.key.remoteJid, d.key.remoteJidAlt);
    anota(d.key.participant, d.key.participantAlt);
    if (pares.length === 0) return;

    await this.#deps.db
      .insert(identityMapTable)
      .values(pares.map((p) => ({
        lineId: envelope.lineId, lid: p.lid, phone: p.phone, source: "server",
      })))
      .onConflictDoUpdate({
        target: [identityMapTable.lineId, identityMapTable.lid],
        set: { phone: sql`excluded.phone`, updatedAt: new Date() },
      })
      .catch(() => {
        // Aprender una identidad no puede tumbar la ingesta del mensaje.
      });
  }

  /**
   * Trae los nombres de todos los grupos de una línea y los guarda.
   *
   * Es una sola llamada al transporte, no una por grupo: pedirlos de uno en
   * uno en una cuenta con muchos grupos es lo que hace que WhatsApp empiece a
   * limitar las peticiones.
   */
  async sincronizarGrupos(lineId: string): Promise<number> {
    const line = await this.#line(lineId);
    const driver = this.driverFor(line.channelKind);
    if (!driver.listGroups) return 0;

    const grupos = await driver.listGroups(lineId as LineId);
    let guardados = 0;
    for (const g of grupos) {
      if (!g.subject) continue;
      await this.#deps.db
        .insert(groupInfoTable)
        .values({
          lineId, address: g.address.value, subject: g.subject,
          description: g.description ?? null,
          owner: g.owner?.value ?? null,
          size: g.size ?? g.participants.length,
          ...(g.createdAt ? { createdAt: new Date(g.createdAt) } : {}),
        })
        .onConflictDoUpdate({
          target: [groupInfoTable.lineId, groupInfoTable.address],
          set: {
            subject: g.subject,
            description: g.description ?? null,
            size: g.size ?? g.participants.length,
            syncedAt: new Date(),
          },
        });
      await this.#ponerTitulo(lineId, g.address.value, g.subject);
      guardados++;
    }
    return guardados;
  }

  /** Trae el fichero de un mensaje entrante y lo guarda en el almacén. */
  async #descargarMedio(job: InboundMediaJob): Promise<void> {
    const line = await this.#line(job.lineId);
    const driver = this.driverFor(line.channelKind);
    if (!driver.downloadMedia) {
      // El transporte no sabe traer medios. No es un fallo del trabajo: no
      // tiene sentido reintentarlo cuatro veces ni mandarlo a la cola muerta.
      return;
    }

    const medio = await driver.downloadMedia(job.lineId as LineId, job.raw);
    if (!medio) return;

    const key = mediaKey({
      orgId: job.orgId, lineId: job.lineId, messageId: job.providerMessageId,
      ...(medio.fileName ? { fileName: medio.fileName } : {}),
    });
    const guardado = await this.#deps.storage.put(key, medio.bytes, {
      mimeType: medio.mimeType,
      ...(medio.fileName ? { fileName: medio.fileName } : {}),
    });

    await this.#deps.db
      .update(messageTable)
      .set({
        mediaKey: guardado.key,
        mediaMime: medio.mimeType,
        mediaSize: guardado.size,
        mediaFileName: medio.fileName ?? null,
        failureReason: null,
      })
      .where(and(
        eq(messageTable.lineId, job.lineId),
        eq(messageTable.providerMessageId, job.providerMessageId),
      ));

    /*
     * Se avisa de que el fichero ya está.
     *
     * El mensaje llegó antes que su imagen —la descarga va en una cola—, así
     * que quien esté mirando la conversación en vivo ya pintó un hueco. Sin
     * este aviso, el hueco se queda hasta que alguien recarga.
     */
    const sobre = job.raw as { key?: { remoteJid?: string; fromMe?: boolean } } | null;
    await this.publish("message.updated", job.lineId, {
      key: {
        id: job.providerMessageId,
        remoteJid: sobre?.key?.remoteJid ?? null,
        fromMe: sobre?.key?.fromMe ?? false,
      },
      media: {
        url: await this.#deps.storage.signedUrl(guardado.key, 3600),
        mimeType: medio.mimeType,
        fileName: medio.fileName ?? null,
        size: guardado.size,
      },
    });
  }

  /**
   * Aprende cómo se llama la gente y los grupos.
   *
   * Sin esto una conversación se identifica por su dirección, y con el
   * direccionamiento por LID de WhatsApp 7 eso es un número opaco de quince
   * cifras que no se parece ni a un teléfono: la lista de conversaciones queda
   * ilegible y no hay forma de saber a quién se está escribiendo.
   *
   * Hay tres fuentes y ninguna sola basta:
   *
   * - `pushName` de un mensaje entrante es el nombre de QUIEN ESCRIBE. En un
   *   chat individual es también el de la conversación; en un grupo no, y
   *   confundirlos pondría el nombre del último que habló como título del
   *   grupo.
   * - `group.updated` trae el asunto del grupo cuando WhatsApp lo anuncia.
   * - Para un grupo que ya existía antes de que nos enlazáramos no llega
   *   ningún anuncio, así que la primera vez se pregunta al transporte.
   */
  async #aprenderNombre(envelope: EventEnvelope): Promise<void> {
    const d = envelope.data as {
      key?: { remoteJid?: string; participant?: string; fromMe?: boolean };
      pushName?: string | null;
      group?: string; subject?: string;
    };

    try {
      if (envelope.event === "group.updated" && d.group && d.subject) {
        await this.#ponerTitulo(envelope.lineId, d.group, d.subject);
        return;
      }
      if (envelope.event !== "message.received") return;

      const bruto = d.key?.remoteJid;
      if (!bruto) return;
      const chat = tryParseAddress(bruto);
      if (!chat) return;

      const nombre = d.pushName?.trim();

      if (chat.kind === "group") {
        // El nombre va al participante, no al grupo.
        const participante = d.key?.participant ? tryParseAddress(d.key.participant) : null;
        if (participante && nombre) await this.#ponerNombreContacto(envelope.lineId, participante, nombre);
        await this.#tituloDeGrupoSiFalta(envelope.lineId, chat);
        return;
      }

      /*
       * El `pushName` solo titula una conversación de UNA persona.
       *
       * En `status@broadcast` —los estados— el remitente es quien publicó el
       * último, y usarlo como título hacía que la lista enseñara el nombre de
       * un contacto cualquiera donde debería decir "Estados". Es el mismo
       * error que en los grupos, por otra puerta.
       */
      if (chat.kind === "broadcast") {
        await this.#ponerTitulo(envelope.lineId, chat.value, "Estados");
        return;
      }
      if (chat.kind !== "pn" && chat.kind !== "lid") return;
      if (!nombre) return;
      await this.#ponerNombreContacto(envelope.lineId, chat, nombre);
      await this.#ponerTitulo(envelope.lineId, chat.value, nombre);
    } catch {
      // Saber el nombre es una mejora, no un requisito: que falle no puede
      // costar el mensaje.
    }
  }

  async #ponerNombreContacto(lineId: string, address: Address, pushName: string): Promise<void> {
    await this.#deps.db
      .insert(contactTable)
      .values({ id: `ct-${lineId}-${address.value}`, lineId, address: address.value, pushName })
      .onConflictDoUpdate({
        target: [contactTable.lineId, contactTable.address],
        set: { pushName, updatedAt: new Date() },
      });
  }

  /**
   * Pone el título de una conversación.
   *
   * Solo si cambia: una escritura por mensaje entrante convertiría cada chat
   * activo en una fila reescrita cien veces por minuto sin que nada cambie.
   */
  async #ponerTitulo(lineId: string, address: string, titulo: string): Promise<void> {
    await this.#deps.db
      .update(chatTable)
      .set({ title: titulo })
      .where(and(
        eq(chatTable.lineId, lineId),
        eq(chatTable.address, address),
        ne(sql`coalesce(${chatTable.title}, '')`, titulo),
      ));
  }

  /** Pregunta el asunto de un grupo la PRIMERA vez que hace falta, no en cada mensaje. */
  async #tituloDeGrupoSiFalta(lineId: string, group: Address): Promise<void> {
    const filas = await this.#deps.db
      .select({ title: chatTable.title })
      .from(chatTable)
      .where(and(eq(chatTable.lineId, lineId), eq(chatTable.address, group.value)))
      .limit(1);
    if (filas.length === 0 || filas[0]!.title) return;

    const line = await this.#line(lineId);
    const driver = this.driverFor(line.channelKind);
    if (!driver.groupMetadata) return;
    const meta = await driver.groupMetadata(lineId as LineId, group);
    if (meta.subject) await this.#ponerTitulo(lineId, group.value, meta.subject);
  }

  /** El teléfono detrás de un LID, o `null` si no lo sabemos. `null` no es "no tiene". */
  async phoneForLid(lineId: string, lid: Address): Promise<Address | null> {
    const filas = await this.#deps.db
      .select({ phone: identityMapTable.phone })
      .from(identityMapTable)
      .where(and(eq(identityMapTable.lineId, lineId), eq(identityMapTable.lid, lid.value)))
      .limit(1);
    return filas[0] ? tryParseAddress(filas[0].phone) : null;
  }

  /** El LID de un teléfono, si alguna vez lo hemos visto. */
  async lidForPhone(lineId: string, phone: Address): Promise<Address | null> {
    const filas = await this.#deps.db
      .select({ lid: identityMapTable.lid })
      .from(identityMapTable)
      .where(and(eq(identityMapTable.lineId, lineId), eq(identityMapTable.phone, phone.value)))
      .limit(1);
    return filas[0] ? tryParseAddress(filas[0].lid) : null;
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

    /*
     * El medio se encola DESPUÉS de tener la fila.
     *
     * Al revés, el trabajador podría llegar a actualizar un mensaje que
     * todavía no existe y la descarga se perdería sin dejar rastro.
     */
    if (MEDIA_KINDS.has(d.kind ?? "text")) {
      await this.#deps.queue.enqueue<InboundMediaJob>(
        INBOUND_MEDIA_QUEUE,
        {
          lineId: envelope.lineId, orgId: envelope.orgId,
          messageId: `m-${envelope.lineId}-${d.key.id}`,
          providerMessageId: d.key.id,
          timestamp: when.getTime(),
          raw: envelope.data,
        },
        {
          partitionKey: `line:${envelope.lineId}`,
          idempotencyKey: `media:${envelope.lineId}:${d.key.id}`,
          maxAttempts: 4,
          backoffMs: 5000,
        },
      );
    }

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
    await this.#mediaWorker?.stop();
    await this.#outboundWorker?.stop();
    for (const off of this.#unsubscribes) off();
    this.#unsubscribes.length = 0;
  }
}
