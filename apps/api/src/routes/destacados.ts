import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError, parseAddress } from "@omni/shared";
import { authorize, route as routeOf, type Principal } from "@omni/core";
import { messageTable, nombresDe, starredMessageTable, type Database } from "@omni/db";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Container } from "../container.js";
import type { ApiEnv } from "./shared.js";
import { errors, json } from "./shared.js";

/**
 * Mensajes destacados: la estrella de WhatsApp, guardada en Omni.
 *
 * En Omni y no en el teléfono. WhatsApp la sincroniza por el estado de la
 * aplicación, que la API oficial y whatsapp-web.js no exponen: guardada aquí
 * funciona igual en todos los transportes, sin capacidad que comprobar.
 *
 * Y es DE QUIEN LA PONE, como en WhatsApp lo es de cada cuenta: lo que Ana
 * destaca para acordarse no le sale destacado a Bruno. Una clave de API tiene
 * los suyos, que no son de nadie más.
 */

/** Quién destaca: una persona del panel, o una clave. */
export function duenoDe(p: Principal): { kind: "user" | "api-key"; id: string } {
  return p.kind === "user" ? { kind: "user", id: p.userId } : { kind: "api-key", id: p.apiKeyId };
}

/**
 * De una página de mensajes, cuáles tiene destacados quien pregunta. Una sola
 * consulta para toda la página: una por burbuja serían cien viajes a la base.
 *
 * Se compara la clave ENTERA del mensaje, id y hora: `message` solo garantiza
 * la pareja, y un transporte que repite identificadores —el sandbox al
 * reiniciarse— pintaría la estrella en un mensaje que nadie destacó.
 */
export async function destacadosDe(
  db: Database, principal: Principal, lineId: string,
  mensajes: readonly { id: string; timestamp: Date }[],
): Promise<(m: { id: string; timestamp: Date }) => boolean> {
  if (mensajes.length === 0) return () => false;
  const dueno = duenoDe(principal);
  const filas = await db
    .select({ id: starredMessageTable.messageId, at: starredMessageTable.messageAt })
    .from(starredMessageTable)
    .where(and(
      eq(starredMessageTable.ownerKind, dueno.kind),
      eq(starredMessageTable.ownerId, dueno.id),
      eq(starredMessageTable.lineId, lineId),
      inArray(starredMessageTable.messageId, mensajes.map((m) => m.id)),
    ));
  const claves = new Set(filas.map((f) => `${f.id} ${f.at.getTime()}`));
  return (m) => claves.has(`${m.id} ${m.timestamp.getTime()}`);
}

const DestacadoSchema = z.object({
  id: z.string(),
  providerMessageId: z.string().nullable(),
  fromMe: z.boolean(),
  senderAddress: z.string().nullable(),
  senderName: z.string().nullable(),
  kind: z.string(),
  body: z.string().nullable(),
  /** Cuándo se escribió: es lo que sirve para ir a él en el hilo. */
  timestamp: z.string(),
  starredAt: z.string(),
}).openapi("MensajeDestacado");

export function registerStarredRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const db = container.dbh.db;
  const Ok = z.object({ data: z.object({ ok: z.boolean() }) });
  const params = z.object({
    lineId: z.string(), chatId: z.string(),
    messageId: z.string().describe("El `id` de Omni o el `providerMessageId` de WhatsApp"),
  });

  /**
   * El mensaje, por cualquiera de sus dos identificadores, y en ESTE chat: una
   * clave acotada a un chat no puede destacar lo de otro dando su id.
   */
  const mensaje = async (lineId: string, chat: string, messageId: string) => {
    const [fila] = await db
      .select({ id: messageTable.id, timestamp: messageTable.timestamp, chatId: messageTable.chatId })
      .from(messageTable)
      .where(and(
        eq(messageTable.lineId, lineId),
        eq(messageTable.chatId, chat),
        or(eq(messageTable.id, messageId), eq(messageTable.providerMessageId, messageId)),
      ))
      .limit(1);
    if (!fila) throw new OmniError("not_found", `el mensaje "${messageId}" no está en esta conversación`);
    return fila;
  };

  app.openapi(
    createRoute({
      method: "put", path: "/v1/lines/{lineId}/chats/{chatId}/messages/{messageId}/star",
      tags: ["mensajes"], summary: "Destacar un mensaje",
      description:
        "Se guarda en Omni, no en el teléfono, y es de quien lo destaca: cada persona " +
        "del panel y cada clave tienen los suyos. Destacar dos veces no falla.",
      request: { params },
      responses: { 200: json(Ok, "destacado"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId, messageId } = c.req.valid("param");
      const chat = parseAddress(decodeURIComponent(chatId));
      const principal = c.get("principal");
      await authorize(principal, routeOf("message.star"), { lineId, chat });
      const m = await mensaje(lineId, chat.value, decodeURIComponent(messageId));
      const dueno = duenoDe(principal);
      await db.insert(starredMessageTable).values({
        ownerKind: dueno.kind, ownerId: dueno.id, lineId,
        chatId: m.chatId, messageId: m.id, messageAt: m.timestamp,
      }).onConflictDoNothing();
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/lines/{lineId}/chats/{chatId}/messages/{messageId}/star",
      tags: ["mensajes"], summary: "Quitar un mensaje de los destacados",
      description: "Solo los de quien llama. Quitar uno que no estaba no falla.",
      request: { params },
      responses: { 200: json(Ok, "quitado"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId, messageId } = c.req.valid("param");
      const chat = parseAddress(decodeURIComponent(chatId));
      const principal = c.get("principal");
      await authorize(principal, routeOf("message.star"), { lineId, chat });
      const m = await mensaje(lineId, chat.value, decodeURIComponent(messageId));
      const dueno = duenoDe(principal);
      await db.delete(starredMessageTable).where(and(
        eq(starredMessageTable.ownerKind, dueno.kind),
        eq(starredMessageTable.ownerId, dueno.id),
        eq(starredMessageTable.lineId, lineId),
        eq(starredMessageTable.messageId, m.id),
      ));
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/chats/{chatId}/starred",
      tags: ["mensajes"], summary: "Los mensajes destacados de una conversación",
      description:
        "Los de quien llama, el último que se destacó primero. Lo borrado para todos " +
        "no sale: en WhatsApp, borrar un mensaje le quita la estrella.",
      request: {
        params: z.object({ lineId: z.string(), chatId: z.string() }),
        query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      },
      responses: { 200: json(z.object({ data: z.array(DestacadoSchema) }), "ok"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      const chat = parseAddress(decodeURIComponent(chatId));
      const principal = c.get("principal");
      await authorize(principal, routeOf("message.starred"), { lineId, chat });
      const dueno = duenoDe(principal);

      const filas = await db
        .select({
          id: messageTable.id, providerMessageId: messageTable.providerMessageId,
          fromMe: messageTable.fromMe, senderAddress: messageTable.senderAddress,
          kind: messageTable.kind, body: messageTable.body, timestamp: messageTable.timestamp,
          starredAt: starredMessageTable.starredAt,
        })
        .from(starredMessageTable)
        .innerJoin(messageTable, and(
          eq(messageTable.lineId, starredMessageTable.lineId),
          eq(messageTable.id, starredMessageTable.messageId),
          // La mitad de la clave que dice en qué partición está.
          eq(messageTable.timestamp, starredMessageTable.messageAt),
        ))
        .where(and(
          eq(starredMessageTable.ownerKind, dueno.kind),
          eq(starredMessageTable.ownerId, dueno.id),
          eq(starredMessageTable.lineId, lineId),
          eq(starredMessageTable.chatId, chat.value),
          isNull(messageTable.deletedAt),
        ))
        .orderBy(desc(starredMessageTable.starredAt))
        .limit(limit);

      const nombres = await nombresDe(db, lineId,
        [...new Set(filas.map((f) => f.senderAddress).filter((x): x is string => x !== null))]);
      return c.json({
        data: filas.map((f) => ({
          id: f.id, providerMessageId: f.providerMessageId, fromMe: f.fromMe,
          senderAddress: f.senderAddress,
          senderName: f.fromMe || !f.senderAddress
            ? null
            : nombres.get(f.senderAddress) ?? f.senderAddress.split("@")[0]!,
          kind: f.kind, body: f.body,
          timestamp: f.timestamp.toISOString(), starredAt: f.starredAt.toISOString(),
        })),
      }, 200);
    },
  );
}
