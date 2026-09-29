import { and, desc, eq } from "drizzle-orm";
import { parseAddress } from "@omni/shared";
import type { PluginHostApi } from "@omni/plugins";
import type { Kv } from "@omni/platform";
import { chatTable, labelAssignmentTable, lineTable, messageTable, type Database } from "@omni/db";
import type { EngineRuntime } from "@omni/engine";

/**
 * Lo que un plugin puede hacer, atado a UNA organización.
 *
 * Cada método filtra por `orgId` antes de tocar nada: un plugin instalado en
 * una organización no puede leer ni escribir en otra ni equivocándose.
 */
export function hostApiPara(
  orgId: string,
  db: Database,
  runtime: EngineRuntime,
  kv: Kv,
): PluginHostApi {
  const lineaDe = async (lineId: string): Promise<boolean> => {
    const filas = await db.select({ id: lineTable.id }).from(lineTable)
      .where(and(eq(lineTable.id, lineId), eq(lineTable.orgId, orgId))).limit(1);
    return filas.length > 0;
  };

  const exigirLinea = async (lineId: string): Promise<void> => {
    if (!(await lineaDe(lineId))) {
      throw new Error(`la línea "${lineId}" no es de esta organización`);
    }
  };

  return {
    async enviarMensaje(lineId, to, text, opts) {
      await exigirLinea(lineId);
      const r = await runtime.send(lineId, {
        to, text, ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
        clientMessageId: `plugin-${crypto.randomUUID()}`,
      });
      return { messageId: r.messageId };
    },

    async leerMensajes(lineId, chat, limite) {
      await exigirLinea(lineId);
      const direccion = parseAddress(chat);
      const filas = await db.select({
        id: messageTable.id, fromMe: messageTable.fromMe, kind: messageTable.kind,
        body: messageTable.body, state: messageTable.state, timestamp: messageTable.timestamp,
      }).from(messageTable)
        .where(and(eq(messageTable.lineId, lineId), eq(messageTable.chatId, direccion.value)))
        .orderBy(desc(messageTable.timestamp))
        .limit(Math.min(limite, 200));
      return filas.map((f) => ({ ...f, timestamp: f.timestamp.toISOString() }));
    },

    async listarChats(lineId, limite) {
      await exigirLinea(lineId);
      const filas = await db.select({
        address: chatTable.address, kind: chatTable.kind,
        title: chatTable.title, unreadCount: chatTable.unreadCount,
      }).from(chatTable)
        .where(eq(chatTable.lineId, lineId))
        .orderBy(desc(chatTable.lastMessageAt))
        .limit(Math.min(limite, 200));
      return filas;
    },

    async listarLineas() {
      return db.select({
        id: lineTable.id, name: lineTable.name,
        channelKind: lineTable.channelKind, status: lineTable.status,
      }).from(lineTable).where(eq(lineTable.orgId, orgId));
    },

    async etiquetarChat(lineId, chat, labelIds) {
      await exigirLinea(lineId);
      const direccion = parseAddress(chat);
      await db.delete(labelAssignmentTable).where(
        and(eq(labelAssignmentTable.lineId, lineId), eq(labelAssignmentTable.target, direccion.value)),
      );
      if (labelIds.length > 0) {
        await db.insert(labelAssignmentTable).values(
          labelIds.map((labelId) => ({
            labelId, lineId, target: direccion.value, targetKind: "chat" as const,
          })),
        ).onConflictDoNothing();
      }
    },

    // Las claves llegan ya con el prefijo del plugin puesto por el supervisor;
    // aquí se añade el de la organización, para que dos no se crucen.
    kvGet: (clave) => kv.get(`org:${orgId}:${clave}`),
    kvSet: (clave, valor, ttl) => kv.set(`org:${orgId}:${clave}`, valor, ttl),

    fetchImpl: fetch,
    log: () => {},
  };
}
