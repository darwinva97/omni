import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  OmniError, parseAddress, tryParseAddress, resolveContent, advanceState, tokensDeMencion,
  siguienteEstadoDeLlamada, llamadaTerminada, type CallRecord,
  type Address, type ChannelKind, type EventEnvelope, type LineId, type MessageKind,
  type SendMessageInput,
} from "@omni/shared";
import type { ChannelDriver, LineStatus, OutboundCommand } from "@omni/channels";
import { assertCapability, descifrarEdicion, descifrarVoto, encuestaDe, extractText } from "@omni/channels";
import type { JobQueue, Kv, Subscription } from "@omni/platform";
import type { Bus } from "@omni/platform";
import type { Database } from "@omni/db";
import { authStateTable, chatTable, contactTable, groupInfoTable, identityMapTable, lineTable, messageTable, contactosDeLinea, fotosDe, nombresDe, nombresDeMenciones, pollTable, pollVoteTable, reactionTable } from "@omni/db";
import type { WebhookDispatcher } from "@omni/core";
import { mediaKey, resolveMedia, type Storage } from "@omni/storage";
import { Conversor, necesitaConversion } from "@omni/media";
import { SecretBox } from "../crypto/secret-box.js";
import { SendPacer } from "../outbound/pacer.js";

export const OUTBOUND_QUEUE = "outbound";

/**
 * Formatos que WhatsApp exige de verdad, comprobados ANTES de aceptar.
 *
 * Un sticker tiene que ser WebP: mandar un JPEG en ese campo no da error, se
 * entrega y al destinatario le llega un cuadrado roto. Es el tipo de fallo que
 * hay que convertir en un 422 inmediato, porque el silencio lo descubre el
 * cliente final y no quien envía.
 */
export function exigirFormatoDelMedio(campo: string, mimeType: string): void {
  const tipo = mimeType.split(";")[0]!.trim().toLowerCase();

  if (campo === "sticker" && tipo !== "image/webp") {
    throw new OmniError(
      "validation_failed",
      `un sticker tiene que ser WebP y este es "${tipo}"; WhatsApp acepta el envío y entrega algo que no se ve`,
      { campo: "sticker", esperado: "image/webp", recibido: tipo },
    );
  }
  if (campo === "image" && !tipo.startsWith("image/")) {
    throw new OmniError("validation_failed", `"${tipo}" no es una imagen`, { campo: "image" });
  }
  // Un GIF es legítimo en el campo del vídeo: se convierte a MP4 antes de
  // enviarlo, que es lo que WhatsApp llama «GIF».
  if (campo === "video" && tipo === "image/gif") return;
  if (campo === "video" && !tipo.startsWith("video/")) {
    throw new OmniError("validation_failed", `"${tipo}" no es un vídeo`, { campo: "video" });
  }
  if (campo === "audio" && !tipo.startsWith("audio/")) {
    throw new OmniError("validation_failed", `"${tipo}" no es un audio`, { campo: "audio" });
  }
}

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

/**
 * Las fotos de perfil se traen en su propia cola.
 *
 * La URL que da WhatsApp caduca en horas, así que hay que DESCARGARLA, y eso
 * es una petición de red por conversación: hacerlo dentro de la ingesta ataría
 * la llegada de un mensaje a bajarse una foto. Aparte, además, porque fallar
 * al traer una foto no debe reintentarse con la misma insistencia que un
 * mensaje perdido.
 */
export const AVATAR_QUEUE = "avatars";

export interface AvatarJob {
  readonly lineId: string;
  readonly orgId: string;
  readonly address: string;
}

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

/** Un `protocolMessage` de WhatsApp: a qué mensaje apunta y qué pide. */
type Protocolo = {
  key?: { id?: string }; type?: number | string;
  editedMessage?: object; timestampMs?: number | string;
  ephemeralExpiration?: number | null;
};

/** `Message.ProtocolMessage.Type.EPHEMERAL_SETTING`: «los mensajes de aquí caducan en…». */
const EPHEMERAL_SETTING = 3;

/** `Message.ProtocolMessage.Type.MESSAGE_EDIT`: «este mensaje dice ahora otra cosa». */
const MESSAGE_EDIT = 14;

/** `Message.ProtocolMessage.Type.REVOKE`: «elimina aquel mensaje». */
const REVOKE = 0;

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
  /** Convierte lo que graba un navegador a lo que WhatsApp reproduce. */
  readonly conversor?: Conversor;
  /** Para bajar las fotos de perfil. Inyectable para poder probarlo sin red. */
  readonly fetchImpl?: typeof fetch;
  readonly storage: Storage;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export interface SendAccepted {
  readonly clientMessageId: string;
  readonly messageId: string;
  readonly state: "queued";
  /**
   * El fichero que se va a enviar, ya convertido si hizo falta.
   *
   * Se devuelve para que quien envía pueda pintarlo al instante. Sin esto, el
   * panel enseñaba el mensaje con un hueco de «descargando…» que nunca se
   * rellenaba: el fichero ya estaba en el almacén, pero nadie le había dado
   * una URL. Solo se veía tras recargar.
   */
  readonly media?: {
    readonly storageKey: string;
    readonly mimeType: string;
    readonly size: number;
    readonly fileName?: string;
  };
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
  #avatarWorker: Subscription | null = null;
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
    /*
     * La conversión va ANTES de aceptar, no al enviar.
     *
     * Un navegador graba audio en WebM y vídeo en VP8; WhatsApp quiere
     * OGG/Opus y H.264. Si se convirtiera en el trabajador, el cliente
     * recibiría un 202 y el fallo aparecería un minuto después donde nadie
     * mira. Aquí se puede decir que no con el motivo.
     */
    const convertido = media && this.#deps.conversor
      && necesitaConversion(content.field, media.mimeType)
      ? await this.#convertirMedio(
          content.field, media, { orgId: line.orgId, lineId, messageId },
        )
      : media;

    if (convertido) exigirFormatoDelMedio(content.field, convertido.mimeType);

    /*
     * Se ENVÍA a la dirección que se pidió, pero se GUARDA en la conversación
     * que ya hubiera con esa persona. Una integración que escribe al teléfono
     * de alguien cuyo chat está abierto por su LID creaba un segundo chat con
     * la misma persona, con ese único mensaje dentro.
     */
    const enChat = await this.#conversacionDe(lineId, to);

    const inserted = await this.#deps.db
      .insert(messageTable)
      .values({
        id: messageId, timestamp: new Date(this.#now()), lineId, chatId: enChat.value,
        clientMessageId, senderAddress: line.address ?? "", fromMe: true, kind,
        body: input.text ?? input.caption ?? null, state: "queued",
        replyToId: input.replyTo ?? null, mentions: input.mentions ? [...input.mentions] : null,
        mediaKey: convertido?.storageKey ?? null,
        mediaMime: convertido?.mimeType ?? null,
        mediaSize: convertido?.size ?? null,
        mediaFileName: convertido?.fileName ?? null,
        sentFromPlatform: true,
        sentByUserId: actor.userId ?? null,
        sentByConnectorId: actor.connectorId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: messageTable.id });

    const descripcionDelMedio = convertido
      ? {
          media: {
            storageKey: convertido.storageKey,
            mimeType: convertido.mimeType,
            size: convertido.size,
            ...(convertido.fileName ? { fileName: convertido.fileName } : {}),
          },
        }
      : {};

    if (inserted.length === 0) {
      return { clientMessageId, messageId, state: "queued", ...descripcionDelMedio };
    }

    /*
     * La conversación existe desde el primer envío.
     *
     * Antes solo se creaba al RECIBIR: escribir desde aquí a alguien nuevo
     * guardaba el mensaje pero la conversación no aparecía en la lista hasta
     * que la otra persona contestaba. Lo propio no deja pendientes.
     */
    await this.#deps.db
      .insert(chatTable)
      .values({
        id: `c-${lineId}-${enChat.value}`, lineId, address: enChat.value, kind: enChat.kind,
        lastMessageAt: new Date(this.#now()), unreadCount: 0,
      })
      .onConflictDoUpdate({
        target: [chatTable.lineId, chatTable.address],
        set: { lastMessageAt: new Date(this.#now()), unreadCount: 0 },
      });

    await this.#deps.queue.enqueue<OutboundJob>(
      OUTBOUND_QUEUE,
      {
        lineId, orgId: line.orgId, clientMessageId, input, kind,
        sentByUserId: actor.userId ?? null, sentByConnectorId: actor.connectorId ?? null,
        mediaKey: convertido?.storageKey ?? null,
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

    return { clientMessageId, messageId, state: "queued", ...descripcionDelMedio };
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
    this.#avatarWorker = this.#deps.queue.process<AvatarJob>(
      AVATAR_QUEUE,
      async (job) => { await this.#descargarAvatar(job); },
      // Poca concurrencia: son fotos, y traerlas no debe competir con enviar.
      { concurrency: 2 },
    );
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

    /*
     * El estado solo AVANZA desde la cola; nunca pisa uno posterior.
     *
     * Los acuses de entregado y leído pueden llegar —y llegan— antes de que
     * `send` vuelva y se escriba esto. Escribir «enviado» sin mirar hacía
     * retroceder un mensaje leído a enviado: el doble check azul volvía a ser
     * un check gris, y se quedaba así. Lo mismo con uno marcado como fallido
     * mientras tanto. La prueba de reintento lo pillaba de vez en cuando, y la
     * primera vez se tapó esperando más en vez de buscar esto.
     *
     * El identificador del proveedor se guarda siempre: sin él, los acuses
     * que lleguen después no encuentran el mensaje.
     */
    await this.#deps.db
      .update(messageTable)
      .set({
        providerMessageId: receipt.providerMessageId,
        state: sql`CASE WHEN ${messageTable.state} = 'queued'
                        THEN ${receipt.state} ELSE ${messageTable.state} END`,
      })
      .where(and(eq(messageTable.lineId, job.lineId), eq(messageTable.clientMessageId, job.clientMessageId)));
  }

  async #markFailed(job: OutboundJob, reason: string): Promise<void> {
    const [fila] = await this.#deps.db
      .update(messageTable)
      .set({ state: "failed", failureReason: reason })
      .where(and(eq(messageTable.lineId, job.lineId), eq(messageTable.clientMessageId, job.clientMessageId)))
      .returning({ chatId: messageTable.chatId });
    /*
     * Al bus también, no solo a los webhooks.
     *
     * Antes solo se enteraba quien tuviera un webhook: el panel seguía
     * enseñando el reloj de «en cola» de un mensaje que ya no iba a salir, y
     * quien lo escribió lo daba por enviado. La conversación va en `key`,
     * como en el resto de eventos de mensaje, para que una credencial
     * acotada a ese chat también lo vea; es la de la fila, no la que se pidió:
     * «51988777666» se guardó como su chat de verdad, con su dominio.
     */
    const evento: EventEnvelope = {
      id: this.#newId(), event: "message.failed", orgId: job.orgId, lineId: job.lineId,
      timestamp: this.#now(),
      data: {
        clientMessageId: job.clientMessageId, reason,
        key: { remoteJid: fila?.chatId ?? job.input.to, fromMe: true },
      },
    };
    await this.#deps.bus.publish(`org:${job.orgId}`, evento);
    await this.#deps.dispatcher.dispatch(evento);
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
  async #ingest(entrada: EventEnvelope): Promise<void> {
    let envelope = entrada;
    try {
      /*
       * Una edición se aplica ANTES de publicar, y lo que se publica ya lleva
       * el texto nuevo: si llega cifrada, ningún consumidor —el panel, un
       * webhook— podría abrirla, porque la clave está en el mensaje original.
       */
      if (envelope.event === "message.updated") {
        const aplicada = await this.#aplicarEdicion(envelope);
        if (aplicada === null) return;
        envelope = aplicada;
      }
      // Lo que se publica de una llamada ya lleva en qué quedó y en qué chat.
      if (envelope.event === "call.received") envelope = await this.#registrarLlamada(envelope);
      // El mapeo LID↔teléfono se aprende ANTES de persistir: si el mensaje se
      // guarda primero y aquí falla algo, el chat queda con un LID que ya no
      // se puede atar a nadie, porque el servidor solo lo dice esta vez.
      await this.#aprenderIdentidad(envelope);
      /*
       * Se guardan los entrantes Y los que salen del TELÉFONO.
       *
       * Un mensaje escrito desde la aplicación de WhatsApp llega aquí como eco
       * con `fromMe`, y antes se tiraba: la conversación en el panel se quedaba
       * con la mitad, sin lo que el propio usuario había contestado desde el
       * móvil. Los que salen de aquí ya tienen su fila desde que se encolan, y
       * el eco los reconoce y no los duplica.
       */
      if (envelope.event === "message.received" || envelope.event === "message.sent") {
        await this.#persistirMensaje(envelope, envelope.event === "message.sent");
      }
      /*
       * Los nombres se aprenden DESPUÉS de persistir.
       *
       * El título vive en la fila de la conversación, y esa fila la crea
       * `#persistInbound`: hacerlo antes dejaba el primer mensaje de cada
       * conversación nueva sin nombre, que es justo el que lo trae.
       */
      await this.#aprenderNombre(envelope);
      if (envelope.event === "message.receipt") await this.#applyReceipt(envelope);
      if (envelope.event === "message.reaction") await this.#aplicarReaccion(envelope);
      if (envelope.event === "poll.vote") await this.#aplicarVoto(envelope);
      /*
       * Un mensaje retirado se MARCA, no se borra.
       *
       * Es el camino limpio: Baileys avisa por `messages.delete` cuando quien
       * escribió retira algo. El otro camino —un `protocolMessage` entre los
       * mensajes— lo cubre `#aplicarProtocolo`, porque según la versión del
       * cliente llega por uno o por el otro.
       */
      /*
       * Lo que se toca en el teléfono se refleja aquí.
       *
       * Silenciar, archivar o fijar una conversación desde WhatsApp llegaba
       * como evento y no lo guardaba nadie: el panel seguía sonando por un
       * chat que su dueño había silenciado hacía semanas.
       */
      if (envelope.event === "chat.updated") await this.#aplicarCambioDeChat(envelope);
      if (envelope.event === "message.deleted") {
        const d = envelope.data as { key?: { id?: string } };
        await this.#marcarRetirado(envelope.lineId, d.key?.id, envelope.timestamp);
      }
      /*
       * Una caída que nadie pidió llega SOLO como evento: Baileys emite
       * `session.disconnected` sin `session.status`. Sin apuntarlo aquí, la
       * línea seguía «conectada» en la base —y en el panel— mientras no
       * recibía nada.
       */
      if (envelope.event === "session.disconnected") await this.#setStatus(envelope.lineId, "disconnected");
      if (envelope.event === "session.logged_out") await this.#setStatus(envelope.lineId, "logged-out");
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
          void this.sincronizarCanales(envelope.lineId).catch(() => {});
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
      const publicado = await this.#conNombres(envelope);
      await this.#deps.bus.publish(`org:${envelope.orgId}`, publicado);
      await this.#deps.dispatcher.dispatch(publicado);

      for (const oyente of this.#oyentes) {
        try {
          await oyente(publicado);
        } catch {
          // Un oyente roto no puede impedir que lleguen los siguientes eventos.
        }
      }
    } catch {
      // Un fallo ingiriendo un evento no puede tumbar la conexión de la línea.
    }
  }

  /**
   * La conversación de una persona: UNA, aunque tenga dos direcciones.
   *
   * WhatsApp identifica a la misma persona por su teléfono o por su LID, y
   * usa una u otra según quién escriba y desde dónde. Si ya hay chat por
   * cualquiera de las dos, es ese; si no hay ninguno, el de la dirección
   * dada. Los grupos y lo demás, tal cual.
   */
  async #conversacionDe(lineId: string, direccion: Address): Promise<Address> {
    if (direccion.kind !== "pn" && direccion.kind !== "lid") return direccion;
    const [par] = await this.#deps.db
      .select({ lid: identityMapTable.lid, phone: identityMapTable.phone })
      .from(identityMapTable)
      .where(and(
        eq(identityMapTable.lineId, lineId),
        direccion.kind === "lid"
          ? eq(identityMapTable.lid, direccion.value)
          : eq(identityMapTable.phone, direccion.value),
      ))
      .limit(1);
    const gemela = par ? (direccion.kind === "lid" ? par.phone : par.lid) : null;
    if (!gemela) return direccion;

    const existentes = await this.#deps.db
      .select({ address: chatTable.address })
      .from(chatTable)
      .where(and(eq(chatTable.lineId, lineId), inArray(chatTable.address, [direccion.value, gemela])));
    const hay = new Set(existentes.map((c) => c.address));
    if (hay.has(direccion.value) || !hay.has(gemela)) return direccion;
    return tryParseAddress(gemela) ?? direccion;
  }

  /**
   * El evento de un mensaje, con los nombres ya puestos.
   *
   * Lo que sale por el socket y por los webhooks traía `@120238196658384` y la
   * dirección de quien escribe, y cada consumidor tenía que resolver nombres
   * por su cuenta —el panel no podía, porque no tiene la agenda—. Se resuelven
   * aquí, que es donde está, con la misma regla que usa la API.
   *
   * Se AÑADE y no se sustituye: `text` y `key` llegan intactos. Quien quiera
   * el dato crudo lo sigue teniendo, y quien quiera enseñarlo tiene
   * `senderName`, `senderAvatarUrl` (en grupos), `mentionNames` (número de
   * la mención → nombre) y, si se comparte un contacto, `contacts`: su tarjeta
   * leída, con el chat que ya hay con cada número.
   */
  async #conNombres(envelope: EventEnvelope): Promise<EventEnvelope> {
    if (envelope.event === "presence.updated") return this.#presenciaConNombres(envelope);
    if (envelope.event !== "message.received" && envelope.event !== "message.sent") {
      return envelope;
    }
    try {
      const d = envelope.data as {
        key?: { remoteJid?: string; participant?: string; fromMe?: boolean };
        text?: string | null; mentions?: string[]; kind?: string;
      };
      const chat = d.key?.remoteJid;
      const autor = d.key?.fromMe ? undefined : d.key?.participant ?? chat;
      // En qué conversación se guardó, que puede no ser `remoteJid`: el panel
      // pinta el mensaje en ESE chat.
      const enChat = chat ? tryParseAddress(chat) : null;
      const chatId = enChat ? (await this.#conversacionDe(envelope.lineId, enChat)).value : null;
      const tokens = tokensDeMencion(d.text);

      // La foto de quien escribe solo en un grupo: en un chat de dos ya está
      // en la cabecera.
      const enGrupo = Boolean(chat?.endsWith("@g.us"));
      const [nombres, menciones, fotos, contactos] = await Promise.all([
        autor ? nombresDe(this.#deps.db, envelope.lineId, [autor]) : new Map<string, string>(),
        nombresDeMenciones(this.#deps.db, envelope.lineId, tokens, d.mentions ?? []),
        autor && enGrupo
          ? fotosDe(this.#deps.db, envelope.lineId, [autor])
          : new Map<string, string>(),
        // Un contacto compartido, ya leído: si no, el panel enseñaba
        // «Contacto» hasta recargar.
        d.kind === "contact"
          ? contactosDeLinea(this.#deps.db, envelope.lineId, [d],
              (clave) => this.#deps.storage.signedUrl(clave, 3600)).then(([c]) => c ?? [])
          : [],
      ]);
      const foto = autor ? fotos.get(autor) : undefined;

      return {
        ...envelope,
        data: {
          ...(envelope.data as object),
          ...(chatId ? { chatId } : {}),
          ...(autor && nombres.has(autor) ? { senderName: nombres.get(autor) } : {}),
          ...(foto ? { senderAvatarUrl: await this.#deps.storage.signedUrl(foto, 3600) } : {}),
          ...(menciones.size > 0
            ? { mentionNames: Object.fromEntries([...menciones].map(([t, m]) => [t, m.name])) }
            : {}),
          ...(contactos.length > 0 ? { contacts: contactos } : {}),
        },
      };
    } catch {
      // Sin nombres el evento sigue valiendo: se publica tal cual llegó.
      return envelope;
    }
  }

  /**
   * La presencia, lista para enseñar: quién, qué hace y cómo se llama.
   *
   * WhatsApp manda `presences` indexado por participante, con su
   * `lastKnownPresence`. Se añade `estados` —una entrada por persona, sin la
   * propia línea— con el nombre puesto por la misma regla que los mensajes:
   * en un grupo, «Rodrigo está escribiendo…» y no un número.
   */
  async #presenciaConNombres(envelope: EventEnvelope): Promise<EventEnvelope> {
    try {
      const d = envelope.data as {
        chat?: string;
        presences?: Record<string, { lastKnownPresence?: string; lastSeen?: number }>;
      };
      if (!d.chat || !d.presences) return envelope;

      // Las direcciones de la propia línea, por las dos vías: su teléfono y
      // su LID. Con varios dispositivos, WhatsApp a veces reporta la nuestra.
      const [linea] = await this.#deps.db
        .select({ address: lineTable.address }).from(lineTable)
        .where(eq(lineTable.id, envelope.lineId)).limit(1);
      const propias = new Set<string>();
      if (linea?.address) {
        propias.add(linea.address);
        const lids = await this.#deps.db
          .select({ lid: identityMapTable.lid }).from(identityMapTable)
          .where(and(eq(identityMapTable.lineId, envelope.lineId),
            eq(identityMapTable.phone, linea.address)));
        for (const l of lids) propias.add(l.lid);
      }
      const usuario = (a: string): string => a.split("@")[0]!.split(":")[0]!;
      const esPropia = (a: string): boolean =>
        [...propias].some((p) => usuario(p) === usuario(a));

      const entradas = Object.entries(d.presences).filter(([a]) => !esPropia(a));
      const nombres = await nombresDe(this.#deps.db, envelope.lineId, entradas.map(([a]) => a));
      return {
        ...envelope,
        data: {
          ...d,
          estados: entradas.map(([address, p]) => ({
            address,
            name: nombres.get(address) ?? usuario(address),
            state: p.lastKnownPresence ?? "unavailable",
            ...(p.lastSeen ? { lastSeen: p.lastSeen * 1000 } : {}),
          })),
        },
      };
    } catch {
      return envelope;
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
      address?: string; lid?: string; phone?: string;
    };

    const pares: { lid: string; phone: string }[] = [];
    const anota = (lid?: string, phone?: string): void => {
      if (!lid || !phone) return;
      const a = tryParseAddress(lid);
      const b = tryParseAddress(phone);
      // Solo el par que de verdad es (LID, teléfono). WhatsApp a veces manda
      // los dos campos con la misma forma, y guardar eso ensuciaría la tabla.
      if (a?.kind === "lid" && b?.kind === "pn") pares.push({ lid: a.value, phone: b.value });
    };
    if (d.key) {
      anota(d.key.remoteJid, d.key.remoteJidAlt);
      anota(d.key.participant, d.key.participantAlt);
    }
    /*
     * Y de la agenda. Un contacto puede traer sus dos direcciones, y es la
     * única ocasión en que se aprenden las de quien no te ha escrito: sin
     * esto, su chat por LID nunca encontraba el nombre que le pusiste.
     */
    if (envelope.event === "contact.updated") {
      anota(d.lid ?? d.address, d.phone ?? d.address);
    }
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
   * Convierte un medio y guarda el resultado, dejando el original en su sitio.
   *
   * El original NO se borra: si alguien quiere el fichero tal cual lo subió,
   * sigue ahí. Lo que se envía es el convertido.
   */
  async #convertirMedio(
    campo: string,
    medio: NonNullable<Awaited<ReturnType<typeof resolveMedia>>>,
    ctx: { orgId: string; lineId: string; messageId: string },
  ): Promise<NonNullable<Awaited<ReturnType<typeof resolveMedia>>>> {
    const r = await this.#deps.conversor!.convertir(campo, medio.bytes, medio.mimeType);
    const extension = r.mimeType === "audio/ogg" ? "ogg"
      : r.mimeType === "video/mp4" ? "mp4"
      : r.mimeType === "image/webp" ? "webp" : "bin";
    const clave = mediaKey({ ...ctx, fileName: `convertido.${extension}` });
    const guardado = await this.#deps.storage.put(clave, r.bytes, { mimeType: r.mimeType });
    return {
      bytes: r.bytes,
      mimeType: r.mimeType,
      storageKey: guardado.key,
      size: guardado.size,
      checksum: guardado.checksum,
      ...(medio.fileName ? { fileName: medio.fileName } : {}),
    };
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

  /**
   * Pone nombre a los canales que no lo tienen.
   *
   * Un mensaje de canal no trae el nombre del canal, solo su dirección, así
   * que sin esto aparecen como `120363…@newsletter`. Se pregunta solo por los
   * que no tienen título: el nombre de un canal casi nunca cambia, y pedirlo
   * en cada conexión para todos es tráfico que WhatsApp no necesita ver.
   */
  async sincronizarCanales(lineId: string): Promise<number> {
    const line = await this.#line(lineId);
    const driver = this.driverFor(line.channelKind);
    if (!driver.newsletterMetadata) return 0;

    const sinNombre = await this.#deps.db
      .select({ address: chatTable.address })
      .from(chatTable)
      .where(and(
        eq(chatTable.lineId, lineId),
        eq(chatTable.kind, "newsletter"),
        isNull(chatTable.title),
      ));

    let nombrados = 0;
    for (const c of sinNombre) {
      const direccion = tryParseAddress(c.address);
      if (!direccion) continue;
      try {
        const meta = await driver.newsletterMetadata(lineId as LineId, direccion);
        if (!meta.name) continue;
        await this.#ponerTitulo(lineId, c.address, meta.name);
        nombrados++;
      } catch (e) {
        // Un canal borrado o al que ya no se sigue no responde: se queda con
        // su dirección y se sigue con los demás. Pero se DICE: tragárselo en
        // silencio dejó un canal sin nombre sin ninguna pista de por qué.
        console.warn(`no se pudo leer el canal ${c.address}: ${
          e instanceof Error ? e.message : String(e)}`);
      }
    }
    return nombrados;
  }

  /**
   * Vuelve a pedir la agenda y encola las fotos que falten.
   *
   * Es lo que pone al día una línea enlazada antes: los nombres de agenda
   * llegan por la sincronización de estado, que no se repite sola, y las fotos
   * solo se piden cuando llega un mensaje.
   */
  async sincronizarContactos(lineId: string): Promise<{ fotos: number }> {
    const line = await this.#line(lineId);
    const driver = this.driverFor(line.channelKind);
    await driver.resyncContacts?.(lineId as LineId);

    const chats = await this.#deps.db
      .select({ address: chatTable.address })
      .from(chatTable)
      .where(and(eq(chatTable.lineId, lineId), isNull(chatTable.avatarKey)));
    for (const c of chats) {
      await this.encolarAvatar(lineId, line.orgId, c.address, true);
    }
    return { fotos: chats.length };
  }

  /**
   * Pide traer la foto de una conversación, si toca.
   *
   * No se pide en cada mensaje: con `forzar` apagado solo entra la que no
   * tenga foto o la tenga de hace más de una semana. Una foto de perfil cambia
   * cada mucho, y bajarla en cada mensaje sería una petición por mensaje para
   * obtener exactamente lo mismo.
   */
  async encolarAvatar(
    lineId: string, orgId: string, address: string, forzar: boolean,
  ): Promise<void> {
    if (!forzar) {
      const filas = await this.#deps.db
        .select({ key: chatTable.avatarKey, syncedAt: chatTable.avatarSyncedAt })
        .from(chatTable)
        .where(and(eq(chatTable.lineId, lineId), eq(chatTable.address, address)))
        .limit(1);
      /*
       * Sin conversación propia, la foto va al contacto.
       *
       * Es el caso de casi todos los que escriben en un grupo. Antes se
       * abandonaba aquí y nunca tenían foto. Sin fila de contacto tampoco se
       * pide: alguien de quien no sabemos nada no merece una consulta.
       */
      const fila = filas[0] ?? (await this.#deps.db
        .select({ key: contactTable.avatarKey, syncedAt: contactTable.avatarSyncedAt })
        .from(contactTable)
        .where(and(eq(contactTable.lineId, lineId), eq(contactTable.address, address)))
        .limit(1))[0];
      if (!fila) return;
      const fresca = fila.syncedAt
        && Date.now() - fila.syncedAt.getTime() < 7 * 24 * 3600 * 1000;
      if (fila.key && fresca) return;
      if (!fila.key && fresca) return;
    }

    await this.#deps.queue.enqueue<AvatarJob>(
      AVATAR_QUEUE,
      { lineId, orgId, address },
      {
        partitionKey: `line:${lineId}`,
        // Una sola petición viva por conversación: sin esto, una ráfaga de
        // diez mensajes encolaría diez descargas de la misma foto.
        idempotencyKey: `avatar:${lineId}:${address}`,
        maxAttempts: 2,
        backoffMs: 30_000,
      },
    ).catch(() => {});
  }

  /** Trae la foto de perfil de una conversación y la guarda. */
  async #descargarAvatar(job: AvatarJob): Promise<void> {
    const line = await this.#line(job.lineId);
    const driver = this.driverFor(line.channelKind);

    // Se marca el intento ANTES de hacerlo: así una cuenta sin foto no se
    // vuelve a pedir en cada mensaje durante una semana.
    // En los dos sitios: la conversación, si la hay, y el contacto, si lo hay.
    // Una persona con chat propio que además escribe en un grupo tiene que
    // salir con la misma foto en los dos.
    const marcar = async (key: string | null): Promise<void> => {
      const cambio = { avatarSyncedAt: new Date(), ...(key ? { avatarKey: key } : {}) };
      await this.#deps.db
        .update(chatTable).set(cambio)
        .where(and(eq(chatTable.lineId, job.lineId), eq(chatTable.address, job.address)));
      await this.#deps.db
        .update(contactTable).set(cambio)
        .where(and(eq(contactTable.lineId, job.lineId), eq(contactTable.address, job.address)));
    };

    if (!driver.profilePictureUrl) { await marcar(null); return; }

    const url = await driver.profilePictureUrl(job.lineId as LineId, parseAddress(job.address));
    if (!url) { await marcar(null); return; }

    const res = await (this.#deps.fetchImpl ?? fetch)(url);
    if (!res.ok) { await marcar(null); return; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) { await marcar(null); return; }

    const clave = mediaKey({
      orgId: job.orgId, lineId: job.lineId,
      messageId: `avatar-${job.address}`, fileName: "avatar.jpg",
    });
    const guardado = await this.#deps.storage.put(clave, bytes, {
      mimeType: res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg",
    });
    await marcar(guardado.key);
  }

  /**
   * Vuelve a intentar bajar el fichero de un mensaje que se quedó sin él.
   *
   * Antes, un medio que fallaba se quedaba así para siempre: el trabajo se
   * agotaba y no había forma de pedirlo otra vez, aunque la causa ya se
   * hubiera arreglado. El nodo original está guardado, así que no hace falta
   * nada más que volver a encolarlo. Lleva otra clave de idempotencia que el
   * intento original: con la misma, la cola lo daría por hecho.
   *
   * Devuelve `false` si no hay nada que reintentar: ya tiene fichero, o no es
   * un mensaje con fichero.
   */
  async reintentarMedio(lineId: string, messageId: string): Promise<boolean> {
    const line = await this.#line(lineId);
    const [fila] = await this.#deps.db
      .select({
        id: messageTable.id, providerMessageId: messageTable.providerMessageId,
        timestamp: messageTable.timestamp, kind: messageTable.kind,
        mediaKey: messageTable.mediaKey, raw: messageTable.raw,
      })
      .from(messageTable)
      .where(and(eq(messageTable.lineId, lineId), eq(messageTable.id, messageId)))
      .limit(1);
    if (!fila) throw new OmniError("not_found", `el mensaje "${messageId}" no existe en esta línea`);
    if (fila.mediaKey || !MEDIA_KINDS.has(fila.kind) || !fila.providerMessageId || !fila.raw) {
      return false;
    }

    await this.#deps.db
      .update(messageTable).set({ failureReason: null })
      .where(and(eq(messageTable.lineId, lineId), eq(messageTable.id, messageId)));
    await this.#deps.queue.enqueue<InboundMediaJob>(
      INBOUND_MEDIA_QUEUE,
      {
        lineId, orgId: line.orgId, messageId: fila.id,
        providerMessageId: fila.providerMessageId,
        timestamp: fila.timestamp.getTime(), raw: fila.raw,
      },
      {
        partitionKey: `line:${lineId}`,
        idempotencyKey: `media:${lineId}:${fila.providerMessageId}:reintento:${this.#now()}`,
        maxAttempts: 4,
        backoffMs: 5000,
      },
    );
    return true;
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
      address?: string; savedName?: string | null; imgUrl?: string | null;
      username?: string | null;
    };

    try {
      /*
       * La agenda: dos nombres distintos que se guardan los DOS.
       *
       * `savedName` es el que tú le pusiste y `pushName` el que esa persona se
       * puso a sí misma. Al enseñarlo gana el tuyo, pero el suyo no se tira:
       * es el recambio cuando no tienes a alguien guardado, y además cambia
       * por su cuenta sin que tú hagas nada.
       */
      if (envelope.event === "contact.updated" && d.address) {
        const quien = tryParseAddress(d.address);
        if (!quien) return;
        const guardado = d.savedName?.trim();
        const propio = d.pushName?.trim();
        const usuario = d.username?.trim().replace(/^@/, "");
        if (guardado || propio || usuario) {
          await this.#deps.db
            .insert(contactTable)
            .values({
              id: `ct-${envelope.lineId}-${quien.value}`,
              lineId: envelope.lineId, address: quien.value,
              ...(guardado ? { savedName: guardado } : {}),
              ...(propio ? { pushName: propio } : {}),
              ...(usuario ? { username: usuario } : {}),
            })
            .onConflictDoUpdate({
              target: [contactTable.lineId, contactTable.address],
              set: {
                // Solo se pisa lo que viene con valor: un evento que trae el
                // nombre propio no puede borrar el que tú guardaste.
                ...(guardado ? { savedName: guardado } : {}),
                ...(propio ? { pushName: propio } : {}),
                ...(usuario ? { username: usuario } : {}),
                updatedAt: new Date(),
              },
            });
        }
        // `imgUrl` con el valor "changed" significa que la foto cambió: hay
        // que volver a traerla, no que venga la nueva en el evento.
        if (d.imgUrl !== undefined) await this.encolarAvatar(envelope.lineId, envelope.orgId, quien.value, true);
        return;
      }

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
        // Y su foto, para enseñarla junto a su primera burbuja. Se pide una vez
        // por semana como mucho: `encolarAvatar` mira cuándo se pidió.
        if (participante) {
          await this.encolarAvatar(envelope.lineId, envelope.orgId, participante.value, false);
        }
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
      /*
       * El `pushName` NO se escribe como título del chat.
       *
       * El título manda sobre todo lo demás al enseñar, y si se llenara con el
       * nombre que alguien se puso a sí mismo, ganaría al que TÚ le guardaste
       * en la agenda. Se queda en la ficha del contacto, que es su sitio, y el
       * orden lo decide quien lo enseña.
       */
      await this.#ponerNombreContacto(envelope.lineId, chat, nombre);
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

  async #persistirMensaje(envelope: EventEnvelope, propio: boolean): Promise<void> {
    const d = envelope.data as {
      key: { id: string; remoteJid: string; participant?: string };
      kind?: MessageKind; text?: string | null; timestamp?: number;
      clientMessageId?: string;
      replyTo?: { id: string };
      mentions?: string[];
      raw?: { message?: { protocolMessage?: Protocolo } };
    };

    /*
     * Una reacción NO es un mensaje.
     *
     * WhatsApp la entrega por el mismo canal que los mensajes, pero es un dato
     * SOBRE otro mensaje: un pulgar que alguien pone a lo que dijiste. Al
     * guardarla como fila propia, el hilo se llenaba de burbujas vacías con la
     * palabra «reaction» dentro, y la conversación real quedaba enterrada
     * entre ellas. Su sitio es la tabla de reacciones, y ahí llega por su
     * propio evento.
     */
    if (d.kind === "reaction") return;

    // Y un `protocolMessage` tampoco: es una orden sobre el hilo.
    if (d.kind === "system") {
      await this.#aplicarProtocolo(envelope, d.raw?.message?.protocolMessage);
      return;
    }

    // La conversación de esa persona, por la dirección que ya tenga chat: ver
    // `#conversacionDe`. Quién lo escribió sigue siendo la dirección real.
    const chat = await this.#conversacionDe(envelope.lineId, parseAddress(d.key.remoteJid));
    const remitente = d.key.participant ?? d.key.remoteJid;
    const when = new Date(d.timestamp ?? envelope.timestamp);

    /*
     * Un eco de lo que mandamos NOSOTROS ya tiene su fila.
     *
     * Se reconoce por el identificador del cliente, que el driver adjunta a lo
     * que salió de aquí, y si no lo hay, por el del proveedor. Sin esta
     * comprobación, cada mensaje enviado desde el panel aparecería dos veces:
     * el que insertamos al encolar y el que vuelve del servidor.
     */
    if (propio) {
      const yaEsta = await this.#deps.db
        .select({ id: messageTable.id })
        .from(messageTable)
        .where(and(
          eq(messageTable.lineId, envelope.lineId),
          d.clientMessageId
            ? eq(messageTable.clientMessageId, d.clientMessageId)
            : eq(messageTable.providerMessageId, d.key.id),
        ))
        .limit(1);
      if (yaEsta.length > 0) {
        // Puede faltarle el identificador del proveedor si el eco llegó antes
        // de que el envío lo anotara: se completa aquí.
        await this.#deps.db
          .update(messageTable)
          .set({ providerMessageId: d.key.id })
          .where(and(
            eq(messageTable.id, yaEsta[0]!.id),
            isNull(messageTable.providerMessageId),
          ));
        /*
         * Y el mensaje tal cual lo dio el transporte, que solo trae el eco.
         *
         * Al encolar no lo hay. Sin él, Baileys no puede reenviar lo que
         * mandamos nosotros —necesita el original entero, con las claves del
         * fichero si lo lleva— y «Reenviar» de un mensaje propio daba 422.
         */
        await this.#deps.db
          .update(messageTable)
          .set({ raw: envelope.data as never })
          .where(and(eq(messageTable.id, yaEsta[0]!.id), isNull(messageTable.raw)));
        return;
      }
    }

    await this.#deps.db
      .insert(messageTable)
      .values({
        id: `m-${envelope.lineId}-${d.key.id}`, timestamp: when,
        lineId: envelope.lineId, chatId: chat.value, providerMessageId: d.key.id,
        senderAddress: remitente, fromMe: propio,
        kind: d.kind ?? "text", body: d.text ?? null,
        /*
         * A qué responde. La copia del original viaja en `raw`, así que la
         * cita se puede enseñar aunque el mensaje citado no esté en la base.
         */
        replyToId: d.replyTo?.id ?? null,
        // A quién menciona: el texto solo trae `@número`, y sin esto no hay
        // forma de saber luego de quién era cada número.
        mentions: d.mentions?.length ? d.mentions : null,
        // Lo escrito desde el teléfono ya salió: nace enviado, no en cola.
        state: propio ? "sent" : "delivered",
        raw: envelope.data as never,
      })
      .onConflictDoNothing();

    /*
     * Una encuesta deja además su propia fila.
     *
     * Sin ella no hay dónde colgar los votos, que llegan después y por otro
     * evento. La pregunta y las opciones viven en el nodo original, no en el
     * cuerpo del mensaje.
     */
    if (d.kind === "poll") {
      const encuesta = encuestaDe(d.raw as never);
      if (encuesta) {
        await this.#deps.db
          .insert(pollTable)
          .values({
            id: `p-${envelope.lineId}-${d.key.id}`,
            lineId: envelope.lineId, providerMessageId: d.key.id, chatId: chat.value,
            question: encuesta.question, options: encuesta.options,
            allowMultiple: encuesta.multiple,
            createdBy: remitente,
            at: when,
          })
          .onConflictDoNothing();
      }
    }

    /*
     * El medio se encola DESPUÉS de tener la fila.
     *
     * Al revés, el trabajador podría llegar a actualizar un mensaje que
     * todavía no existe y la descarga se perdería sin dejar rastro.
     */
    // La foto de la conversación, una vez: `encolarAvatar` se desentiende sola
    // si ya hay una reciente.
    await this.encolarAvatar(envelope.lineId, envelope.orgId, chat.value, false);

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
        address: chat.value, kind: chat.kind, lastMessageAt: when,
        unreadCount: propio ? 0 : 1,
      })
      .onConflictDoUpdate({
        target: [chatTable.lineId, chatTable.address],
        set: {
          lastMessageAt: when,
          /*
           * Lo propio no suma pendientes: lo escribiste tú. Y además los PONE A
           * CERO, porque escribir desde el teléfono significa que ya has leído
           * esa conversación —es lo que hace WhatsApp— y dejar el globo puesto
           * obligaría a abrirla aquí solo para apagarlo.
           */
          unreadCount: propio ? sql`0` : sql`${chatTable.unreadCount} + 1`,
        },
      });
  }

  /**
   * Guarda una reacción.
   *
   * La tabla existía desde el principio y no la escribía nadie: las reacciones
   * llegaban, se publicaban por el socket y se perdían al recargar. Un emoji
   * VACÍO significa retirarla —así lo expresa WhatsApp— y por eso borra la
   * fila en vez de guardar una cadena vacía que luego habría que filtrar en
   * cada consulta.
   */
  async #aplicarReaccion(envelope: EventEnvelope): Promise<void> {
    const d = envelope.data as {
      key?: { id?: string; participant?: string; fromMe?: boolean; remoteJid?: string };
      emoji?: string;
    };
    const id = d.key?.id;
    if (!id) return;

    // Quién reacciona: en un grupo, el participante; en un chat de dos, el
    // otro extremo, salvo que seamos nosotros.
    const quien = d.key?.fromMe
      ? "yo"
      : d.key?.participant ?? d.key?.remoteJid ?? "desconocido";
    const emoji = (d.emoji ?? "").trim();

    if (!emoji) {
      await this.#deps.db.delete(reactionTable).where(and(
        eq(reactionTable.lineId, envelope.lineId),
        eq(reactionTable.providerMessageId, id),
        eq(reactionTable.reactor, quien),
      ));
      return;
    }

    await this.#deps.db
      .insert(reactionTable)
      .values({ lineId: envelope.lineId, providerMessageId: id, reactor: quien, emoji })
      .onConflictDoUpdate({
        target: [reactionTable.lineId, reactionTable.providerMessageId, reactionTable.reactor],
        set: { emoji, at: new Date() },
      });
  }

  /**
   * Aplica un `protocolMessage`.
   *
   * No es un mensaje: es una orden sobre el hilo, y de las que WhatsApp manda
   * por aquí solo una cambia lo que se lee —REVOKE, «elimina aquel mensaje»—.
   * Guardarla como fila propia hacía lo peor de dos mundos: aparecía una
   * burbuja vacía con la palabra «system» dentro Y el mensaje borrado seguía
   * en su sitio como si nadie lo hubiera retirado.
   *
   * La fila original se marca, no se borra. Quien audita una conversación
   * necesita saber que ahí hubo algo y qué decía; el panel ya se encarga de
   * enseñarlo como retirado.
   */
  async #aplicarProtocolo(envelope: EventEnvelope, protocolo?: Protocolo): Promise<void> {
    if (!protocolo) return;
    // Baileys entrega el enum tal cual lo trae el protobuf: a veces el número,
    // a veces el nombre. Se aceptan los dos en vez de apostar por uno.
    if (protocolo.type === MESSAGE_EDIT || protocolo.type === "MESSAGE_EDIT") {
      // La edición sin cifrar: el texto nuevo viene a la vista.
      if (!protocolo.key?.id || !protocolo.editedMessage) return;
      await this.#guardarEdicion(
        envelope.lineId, protocolo.key.id, extractText(protocolo.editedMessage),
        Number(protocolo.timestampMs ?? envelope.timestamp),
      );
      return;
    }
    /*
     * Alguien puso o quitó los mensajes temporales —el otro lado, o nosotros
     * desde el teléfono—. Es la única forma de enterarse: WhatsApp no deja
     * preguntarlo, así que se apunta en el chat cuando pasa.
     */
    if (protocolo.type === EPHEMERAL_SETTING || protocolo.type === "EPHEMERAL_SETTING") {
      const d = envelope.data as { key?: { remoteJid?: string } };
      const direccion = d.key?.remoteJid ? tryParseAddress(d.key.remoteJid) : null;
      if (!direccion) return;
      const chat = await this.#conversacionDe(envelope.lineId, direccion);
      await this.#deps.db
        .update(chatTable)
        .set({ ephemeralSeconds: Number(protocolo.ephemeralExpiration ?? 0) })
        .where(and(eq(chatTable.lineId, envelope.lineId), eq(chatTable.address, chat.value)));
      return;
    }
    if (protocolo.type !== REVOKE && protocolo.type !== "REVOKE") return;
    await this.#marcarRetirado(envelope.lineId, protocolo.key?.id, envelope.timestamp);
  }

  /**
   * Aplica una edición que llega como `message.updated`.
   *
   * Tres casos: lo que publica el propio motor al bajar un fichero (no es
   * una edición; pasa tal cual), una edición con el texto a la vista, y una
   * cifrada, que se abre con el `messageSecret` del original.
   *
   * Devuelve el evento a publicar —con `text` y sin lo cifrado— o `null` si
   * no hay nada que publicar: una edición de un mensaje que no está aquí no
   * le sirve a nadie, y la cifrada ni siquiera se puede leer.
   */
  async #aplicarEdicion(envelope: EventEnvelope): Promise<EventEnvelope | null> {
    const d = envelope.data as {
      key?: { id?: string; remoteJid?: string };
      text?: string | null; media?: unknown;
      author?: string; alternativas?: string[]; timestamp?: number;
      cifrado?: { encPayload: string; encIv: string; tipo: string };
    };
    if (d.media !== undefined || !d.key?.id) return envelope;
    if (d.text === undefined && !d.cifrado) return envelope;

    let texto = d.text ?? null;
    let cuando = d.timestamp ?? envelope.timestamp;
    if (d.cifrado) {
      if (d.cifrado.tipo !== "MESSAGE_EDIT" || !d.author) return null;
      const [original] = await this.#deps.db
        .select({ raw: messageTable.raw }).from(messageTable)
        .where(and(
          eq(messageTable.lineId, envelope.lineId),
          eq(messageTable.providerMessageId, d.key.id),
        ))
        .limit(1);
      const secreto = (original?.raw as {
        raw?: { message?: { messageContextInfo?: { messageSecret?: string } } };
      } | null)?.raw?.message?.messageContextInfo?.messageSecret;
      if (!secreto) return null;
      // La dirección tal cual primero, y luego sus otras formas: la clave se
      // deriva de ella y WhatsApp no dice cuál usó.
      let abierta: ReturnType<typeof descifrarEdicion> | null = null;
      for (const author of [d.author, ...(d.alternativas ?? [])]) {
        try {
          abierta = descifrarEdicion(d.cifrado, { messageId: d.key.id, author, secret: secreto });
          break;
        } catch { /* la siguiente forma */ }
      }
      if (!abierta) return null;
      texto = abierta.text;
      cuando = abierta.editedAt ?? cuando;
    }

    const hecho = await this.#guardarEdicion(envelope.lineId, d.key.id, texto, cuando);
    if (!hecho) return null;
    const { cifrado: _fuera, ...resto } = d;
    return {
      ...envelope,
      data: { ...resto, text: texto, editedAt: new Date(cuando).toISOString() },
    };
  }

  /** El texto nuevo y cuándo, en el mensaje original. `false` si no está aquí. */
  async #guardarEdicion(
    lineId: string, providerMessageId: string, texto: string | null, cuando: number,
  ): Promise<boolean> {
    if (texto === null) return false;
    const fecha = Number.isFinite(cuando) ? new Date(cuando) : new Date(this.#now());
    const filas = await this.#deps.db
      .update(messageTable)
      .set({ body: texto, editedAt: fecha })
      .where(and(
        eq(messageTable.lineId, lineId),
        eq(messageTable.providerMessageId, providerMessageId),
      ))
      .returning({ id: messageTable.id });
    return filas.length > 0;
  }

  /**
   * Refleja en la fila del chat lo que cambió en WhatsApp.
   *
   * Solo lo que VIENE en el evento: una actualización trae los campos
   * tocados, y escribir los ausentes como nulos borraría el estado real. Si no
   * cambió nada que guardemos, no se toca la base.
   */
  async #aplicarCambioDeChat(envelope: EventEnvelope): Promise<void> {
    const d = envelope.data as {
      chat?: string; archived?: boolean; pinned?: boolean;
      mutedUntil?: number | null; unreadCount?: number;
      /** Segundos que duran los mensajes; 0 = desactivados. */
      ephemeral?: number | null;
    };
    if (!d.chat) return;
    const direccion = tryParseAddress(d.chat);
    if (!direccion) return;

    const cambios: Partial<typeof chatTable.$inferInsert> = {};
    if (d.archived !== undefined) cambios.archived = d.archived;
    if (d.pinned !== undefined) cambios.pinned = d.pinned;
    if (d.mutedUntil !== undefined) {
      cambios.muteUntil = d.mutedUntil ? new Date(d.mutedUntil) : null;
    }
    if (d.unreadCount !== undefined) cambios.unreadCount = Math.max(0, d.unreadCount);
    if (d.ephemeral !== undefined) cambios.ephemeralSeconds = Number(d.ephemeral ?? 0);
    if (Object.keys(cambios).length === 0) return;

    await this.#deps.db
      .update(chatTable)
      .set(cambios)
      .where(and(
        eq(chatTable.lineId, envelope.lineId),
        eq(chatTable.address, direccion.value),
      ));
  }

  /**
   * Una llamada en el hilo: una fila que nace al sonar y cambia con cada paso.
   *
   * WhatsApp enseña «Llamada de voz perdida» en la conversación, y sin esto
   * una llamada que nadie vio no dejaba ningún rastro aquí. La fila no tiene
   * identificador de proveedor: una llamada no es un mensaje, no se cita ni se
   * reacciona. Su identificador es el de la llamada, que repite cada aviso.
   *
   * Devuelve el evento con `chatId` y `call` —el estado ya reducido—, que es
   * lo que necesitan el panel y quien reciba el webhook.
   */
  async #registrarLlamada(envelope: EventEnvelope): Promise<EventEnvelope> {
    const d = envelope.data as {
      callId?: string; from?: string; chatId?: string; status?: string;
      isVideo?: boolean; isGroup?: boolean; offline?: boolean; at?: number; timestamp?: number;
    };
    if (!d.callId || !d.from) return envelope;
    const chat = await this.#conversacionDe(envelope.lineId, parseAddress(d.chatId ?? d.from));
    const id = `m-${envelope.lineId}-call-${d.callId}`;
    const [fila] = await this.#deps.db
      .select({ raw: messageTable.raw })
      .from(messageTable)
      .where(and(eq(messageTable.lineId, envelope.lineId), eq(messageTable.id, id)))
      .limit(1);
    const previa = (fila?.raw as { call?: CallRecord } | null)?.call;

    const at = d.at ?? d.timestamp ?? envelope.timestamp;
    const state = siguienteEstadoDeLlamada(previa?.state, d.status, d.offline);
    const call: CallRecord = {
      id: d.callId,
      from: previa?.from ?? d.from,
      isVideo: Boolean(previa?.isVideo || d.isVideo),
      isGroup: Boolean(previa?.isGroup || d.isGroup),
      state,
      startedAt: previa?.startedAt ?? at,
      answeredAt: previa?.answeredAt ?? (state === "answered" ? at : null),
      endedAt: previa?.endedAt ?? (llamadaTerminada(state) ? at : null),
    };

    if (fila) {
      await this.#deps.db.update(messageTable)
        .set({ raw: { call } as never })
        .where(and(eq(messageTable.lineId, envelope.lineId), eq(messageTable.id, id)));
    } else {
      await this.#deps.db.insert(messageTable).values({
        id, timestamp: new Date(call.startedAt),
        lineId: envelope.lineId, chatId: chat.value, providerMessageId: null,
        senderAddress: d.from, fromMe: false, kind: "call", body: null,
        state: "delivered", raw: { call } as never,
      }).onConflictDoNothing();
      // Una llamada entrante cuenta como pendiente, como en WhatsApp: si nadie
      // la atendió, es lo primero que hay que ver al abrir la conversación.
      await this.#deps.db.insert(chatTable)
        .values({
          id: `c-${envelope.lineId}-${chat.value}`, lineId: envelope.lineId,
          address: chat.value, kind: chat.kind,
          lastMessageAt: new Date(call.startedAt), unreadCount: 1,
        })
        .onConflictDoUpdate({
          target: [chatTable.lineId, chatTable.address],
          set: {
            lastMessageAt: new Date(call.startedAt),
            unreadCount: sql`${chatTable.unreadCount} + 1`,
          },
        });
    }

    // El nombre de quien llama, para el aviso: un número no dice si contestar.
    const nombres = await nombresDe(this.#deps.db, envelope.lineId, [call.from]).catch(() => null);
    const senderName = nombres?.get(call.from);
    return {
      ...envelope,
      data: {
        ...(envelope.data as object), chatId: chat.value, messageId: id, call,
        ...(senderName ? { senderName } : {}),
      },
    };
  }

  /**
   * Guarda un voto de encuesta, descifrándolo primero.
   *
   * La clave sale de la encuesta —de su `messageSecret`, que está en el nodo
   * original guardado— junto con quién la creó y quién vota. Por eso esto vive
   * aquí y no en el driver: el driver tiene el protocolo, pero la clave está
   * en la base.
   *
   * Un voto que no se puede abrir se descarta en silencio y a propósito: pasa
   * cuando la encuesta es anterior a esta línea y no tenemos su nodo. No es un
   * fallo nuestro y no hay nada que reintentar.
   */
  async #aplicarVoto(envelope: EventEnvelope): Promise<void> {
    const d = envelope.data as {
      poll?: { id?: string; author?: string };
      voter?: string;
      alternativas?: { authors?: string[]; voters?: string[] };
      vote?: { encPayload: string; encIv: string };
      at?: number;
    };
    if (!d.poll?.id || !d.poll.author || !d.voter || !d.vote) return;

    const [encuesta] = await this.#deps.db
      .select({ id: pollTable.id, options: pollTable.options })
      .from(pollTable)
      .where(and(
        eq(pollTable.lineId, envelope.lineId),
        eq(pollTable.providerMessageId, d.poll.id),
      ))
      .limit(1);
    if (!encuesta) return;

    // El secreto vive en el nodo original del mensaje de la encuesta, que es
    // lo único que no se puede derivar de nada más.
    const [fila] = await this.#deps.db
      .select({ raw: messageTable.raw })
      .from(messageTable)
      .where(and(
        eq(messageTable.lineId, envelope.lineId),
        eq(messageTable.providerMessageId, d.poll.id),
      ))
      .limit(1);
    const secreto = encuestaDe(
      (fila?.raw as { raw?: unknown } | null)?.raw as never,
    )?.secret;
    if (!secreto) return;

    /*
     * La primera pareja que abra. El GCM no abre a medias: con la clave
     * equivocada lanza, así que probar no puede dar un voto falso.
     */
    const autores = [d.poll.author, ...(d.alternativas?.authors ?? [])];
    const votantes = [d.voter, ...(d.alternativas?.voters ?? [])];
    let elegidas: string[] | null = null;
    for (const pollAuthor of autores) {
      for (const voter of votantes) {
        try {
          elegidas = descifrarVoto(d.vote, {
            pollId: d.poll.id, pollAuthor, voter, secret: secreto,
          }, encuesta.options);
          break;
        } catch { /* la siguiente */ }
      }
      if (elegidas) break;
    }
    if (!elegidas) return;

    /*
     * Se guardan ÍNDICES, no nombres.
     *
     * Dos opciones pueden llamarse igual, y un nombre guardado deja de
     * emparejar si la encuesta se reinterpreta. El índice es lo que WhatsApp
     * enseña: la posición en la lista.
     */
    const indices = elegidas
      .map((o) => encuesta.options.indexOf(o))
      .filter((i) => i >= 0);

    /*
     * Un voto SUSTITUYE al anterior de esa persona, no se suma.
     *
     * WhatsApp manda el estado completo de su voto cada vez que lo cambia, y
     * una lista vacía significa «he retirado mi voto».
     */
    await this.#deps.db
      .insert(pollVoteTable)
      .values({
        pollId: encuesta.id, voter: d.voter, selected: indices,
        at: new Date(d.at ?? envelope.timestamp),
      })
      .onConflictDoUpdate({
        target: [pollVoteTable.pollId, pollVoteTable.voter],
        set: { selected: indices, at: new Date(d.at ?? envelope.timestamp) },
      });
  }

  /** Deja dicho que un mensaje fue retirado, sin perder lo que decía. */
  async #marcarRetirado(lineId: string, providerMessageId: string | undefined, cuando: number)
    : Promise<void> {
    if (!providerMessageId) return;
    await this.#deps.db
      .update(messageTable)
      .set({ deletedAt: new Date(cuando) })
      .where(and(
        eq(messageTable.lineId, lineId),
        eq(messageTable.providerMessageId, providerMessageId),
      ));
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
    await this.#avatarWorker?.stop();
    await this.#mediaWorker?.stop();
    await this.#outboundWorker?.stop();
    for (const off of this.#unsubscribes) off();
    this.#unsubscribes.length = 0;
  }
}
