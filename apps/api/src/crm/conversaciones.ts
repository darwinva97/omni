import { and, eq, ne, sql } from "drizzle-orm";
import { conversationTable, type Database } from "@omni/db";

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

  constructor(db: Database) {
    this.#db = db;
  }

  /** La conversación viva de un chat, abriéndola si no había ninguna. */
  async abrirOEncontrar(
    orgId: string, lineId: string, chatId: string, cuando: Date,
  ): Promise<typeof conversationTable.$inferSelect> {
    const viva = await this.viva(lineId, chatId);
    if (viva) return viva;

    const id = `conv-${crypto.randomUUID()}`;
    const creada = await this.#db.insert(conversationTable).values({
      id, orgId, lineId, chatId, status: "open", openedAt: cuando, lastMessageAt: cuando,
    }).onConflictDoNothing().returning();

    // Si otro proceso ganó la carrera, el índice parcial lo rechazó aquí y la
    // buena es la suya: se relee en vez de fallar.
    if (creada[0]) return creada[0];
    const otra = await this.viva(lineId, chatId);
    if (otra) return otra;
    throw new Error(`no se pudo abrir la conversación de ${chatId}`);
  }

  async viva(lineId: string, chatId: string): Promise<typeof conversationTable.$inferSelect | null> {
    const filas = await this.#db.select().from(conversationTable)
      .where(and(
        eq(conversationTable.lineId, lineId),
        eq(conversationTable.chatId, chatId),
        ne(conversationTable.status, "resolved"),
      ))
      .limit(1);
    return filas[0] ?? null;
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
}
