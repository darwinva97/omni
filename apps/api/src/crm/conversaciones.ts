import { and, desc, eq, ne, sql } from "drizzle-orm";
import { conversationTable, type Database } from "@omni/db";

export type Conversacion = typeof conversationTable.$inferSelect;

/** Lo que se puede cambiar de una conversación, a mano o por una regla. */
export interface CambioDeConversacion {
  readonly status?: Conversacion["status"];
  readonly priority?: Conversacion["priority"];
  readonly assigneeId?: string | null;
  readonly subject?: string | null;
  readonly snoozedUntil?: Date | null;
}

/**
 * Quien se entera de que una conversación cambió.
 *
 * Lo pone el contenedor, que es quien tiene el bus y los webhooks: esta clase
 * solo sabe de la tabla. Sin él, asignar o resolver desde una pestaña no se
 * veía en la de al lado hasta recargar, y dos personas acababan contestando
 * al mismo cliente.
 */
export type PublicarConversacion = (c: Conversacion) => Promise<void>;

/**
 * Conversaciones: el episodio de atención dentro de un chat.
 *
 * Se abre sola con el primer mensaje y se cierra a mano o por una regla. La
 * unicidad de "una abierta por chat" la garantiza un índice parcial en la base,
 * no esta clase: dos procesos ingiriendo a la vez el primer mensaje de alguien
 * llegarían aquí los dos, y sin el índice abrirían dos expedientes.
 */
export class Conversaciones {
  readonly #db: Database;
  readonly #publicar: PublicarConversacion;

  constructor(db: Database, publicar: PublicarConversacion = async () => {}) {
    this.#db = db;
    this.#publicar = publicar;
  }

  /**
   * La conversación viva de un chat, abriéndola si no había ninguna.
   *
   * `assigneeId` es para quien abre: la que se abre hereda al responsable
   * de la anterior, y la que ya estaba viva no se toca.
   */
  async abrirOEncontrar(
    orgId: string, lineId: string, chatId: string, cuando: Date,
    { assigneeId = null }: { assigneeId?: string | null } = {},
  ): Promise<{ conv: Conversacion; nueva: boolean }> {
    const viva = await this.viva(lineId, chatId);
    if (viva) return { conv: viva, nueva: false };

    const id = `conv-${crypto.randomUUID()}`;
    const creada = await this.#db.insert(conversationTable).values({
      id, orgId, lineId, chatId, status: "open", openedAt: cuando, lastMessageAt: cuando,
      assigneeId,
    }).onConflictDoNothing().returning();

    // Si otro proceso ganó la carrera, el índice parcial lo rechazó aquí y la
    // buena es la suya: se relee en vez de fallar.
    if (creada[0]) {
      await this.#publicar(creada[0]).catch(() => {});
      return { conv: creada[0], nueva: true };
    }
    const otra = await this.viva(lineId, chatId);
    if (otra) return { conv: otra, nueva: false };
    throw new Error(`no se pudo abrir la conversación de ${chatId}`);
  }

  async viva(lineId: string, chatId: string): Promise<Conversacion | null> {
    const filas = await this.#db.select().from(conversationTable)
      .where(and(
        eq(conversationTable.lineId, lineId),
        eq(conversationTable.chatId, chatId),
        ne(conversationTable.status, "resolved"),
      ))
      .limit(1);
    return filas[0] ?? null;
  }

  /** La más reciente de un chat, viva o resuelta. */
  async ultima(lineId: string, chatId: string): Promise<Conversacion | null> {
    const filas = await this.#db.select().from(conversationTable)
      .where(and(eq(conversationTable.lineId, lineId), eq(conversationTable.chatId, chatId)))
      .orderBy(desc(conversationTable.openedAt))
      .limit(1);
    return filas[0] ?? null;
  }

  /**
   * Un mensaje, visto desde la atención.
   *
   * Lo ENTRANTE reabre: si la conversación estaba resuelta se abre un
   * episodio nuevo —el anterior queda resuelto, con su fecha, para que las
   * cuentas de cuántas se resolvieron sigan valiendo— y hereda al
   * responsable, porque quien vuelve a escribir espera hablar con quien le
   * atendió. Sin esto el cliente escribía y nadie lo veía en «Míos».
   *
   * Lo SALIENTE no reabre. Resolver y mandar después «¡gracias, buen día!» es
   * el orden natural de despedirse, y abrir un expediente por esa despedida
   * llenaba la bandeja de conversaciones que nadie tiene que atender. Solo
   * abre una cuando el chat no ha tenido ninguna: escribir primero a alguien
   * también es empezar a atenderle.
   */
  async alRecibirMensaje(
    orgId: string, lineId: string, chatId: string, cuando: Date, fromMe: boolean,
  ): Promise<Conversacion | null> {
    const viva = await this.viva(lineId, chatId);
    if (viva) {
      await this.anotarMensaje(viva.id, cuando, fromMe);
      // Solo se avisa si CAMBIÓ algo que se ve: un aviso por mensaje sería
      // ruido, y la lista ya se entera de los mensajes por su propio evento.
      if (!fromMe && (viva.status === "pending" || viva.status === "snoozed")) {
        await this.#publicar({ ...viva, status: "open", lastMessageAt: cuando }).catch(() => {});
      }
      return viva;
    }

    const anterior = await this.ultima(lineId, chatId);
    if (fromMe && anterior) return null;

    const { conv } = await this.abrirOEncontrar(orgId, lineId, chatId, cuando, {
      assigneeId: anterior?.assigneeId ?? null,
    });
    await this.anotarMensaje(conv.id, cuando, fromMe);
    return conv;
  }

  /**
   * Anota un mensaje en la conversación.
   *
   * `firstReplyAt` se pone UNA vez y solo con un mensaje nuestro: es la métrica
   * de cuánto tarda alguien en contestar, y sobrescribirla con cada respuesta
   * la convertiría en "cuándo fue la última", que ya es otra cosa.
   */
  async anotarMensaje(
    convId: string, cuando: Date, fromMe: boolean,
  ): Promise<void> {
    await this.#db.update(conversationTable)
      .set({
        lastMessageAt: cuando,
        updatedAt: new Date(),
        ...(fromMe ? { firstReplyAt: sql`coalesce(${conversationTable.firstReplyAt}, ${cuando})` } : {}),
        /*
         * Un mensaje entrante reabre lo que estaba durmiendo o en espera. Si
         * no, la conversación seguiría fuera de la bandeja mientras el cliente
         * escribe, que es exactamente cuando hay que atenderla.
         */
        ...(!fromMe
          ? { status: sql`case when ${conversationTable.status} in ('snoozed','pending') then 'open' else ${conversationTable.status} end` }
          : {}),
      })
      .where(eq(conversationTable.id, convId));
  }

  /**
   * Cambia una conversación y lo avisa.
   *
   * Es el ÚNICO camino para cambiarla, lo haga una persona o una regla: si
   * cada uno escribiera en la tabla por su cuenta, el que se olvidara de
   * avisar dejaría al resto del equipo mirando un estado viejo.
   */
  async cambiar(id: string, cambio: CambioDeConversacion): Promise<Conversacion | null> {
    const actualizada = await this.#db.update(conversationTable)
      .set({
        ...(cambio.status ? { status: cambio.status } : {}),
        ...(cambio.priority ? { priority: cambio.priority } : {}),
        ...(cambio.assigneeId !== undefined ? { assigneeId: cambio.assigneeId } : {}),
        ...(cambio.subject !== undefined ? { subject: cambio.subject } : {}),
        ...(cambio.snoozedUntil !== undefined ? { snoozedUntil: cambio.snoozedUntil } : {}),
        // Resolverla deja constancia de cuándo; reabrirla la borra, porque
        // una fecha de resolución en una conversación abierta es una mentira.
        ...(cambio.status === "resolved" ? { resolvedAt: new Date() } : {}),
        ...(cambio.status && cambio.status !== "resolved" ? { resolvedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(conversationTable.id, id))
      .returning();
    const conv = actualizada[0] ?? null;
    if (conv) await this.#publicar(conv).catch(() => {});
    return conv;
  }
}

/** La forma pública de una conversación: la de la API, el evento y el panel. */
export function presentarConversacion(c: Conversacion) {
  return {
    id: c.id, lineId: c.lineId, chatId: c.chatId,
    status: c.status, priority: c.priority,
    assigneeId: c.assigneeId, subject: c.subject,
    openedAt: c.openedAt.toISOString(),
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    firstReplyAt: c.firstReplyAt?.toISOString() ?? null,
    resolvedAt: c.resolvedAt?.toISOString() ?? null,
  };
}
