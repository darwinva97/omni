import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError, parseAddress, type EventEnvelope, type EventName } from "@omni/shared";
import { authorize, route as routeOf } from "@omni/core";
import { internalNoteTable, lineTable, userTable } from "@omni/db";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Container } from "../container.js";
import type { ApiEnv } from "./shared.js";
import { errors, json, body } from "./shared.js";

/**
 * Notas internas.
 *
 * Lo que el equipo se dice sobre un chat —«ya le mandé el presupuesto»,
 * «cuidado, reclamó el mes pasado»— dentro del propio chat, intercalado con
 * los mensajes, y que el cliente NO ve nunca.
 *
 * Esa garantía es de diseño, no de cuidado: las notas viven en su propia
 * tabla, y esta ruta no toca el motor, la cola de salida ni la tabla de
 * mensajes. No hay ningún camino desde aquí hasta WhatsApp que un filtro
 * olvidado pudiera abrir.
 */

const NoteSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  body: z.string(),
  createdAt: z.string(),
  /** Quién la escribió: una persona, o una integración con su clave. */
  author: z.object({
    kind: z.enum(["user", "api-key"]),
    /** La persona, cuando la hay. Nulo si la escribió una clave o la cuenta ya no existe. */
    userId: z.string().nullable(),
    name: z.string().nullable(),
  }),
}).openapi("InternalNote");

type Fila = typeof internalNoteTable.$inferSelect & { authorName: string | null };

const presentar = (n: Fila) => ({
  id: n.id,
  chatId: n.chatId,
  body: n.body,
  createdAt: n.createdAt.toISOString(),
  author: {
    kind: (n.authorKeyId ? "api-key" : "user") as "user" | "api-key",
    userId: n.authorUserId,
    name: n.authorName,
  },
});

const Params = z.object({ lineId: z.string(), chatId: z.string() });

export function registerNoteRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const db = container.dbh.db;

  /** La línea tiene que ser de la organización de quien pregunta. */
  const exigirLinea = async (lineId: string, orgId: string): Promise<void> => {
    const filas = await db.select({ id: lineTable.id }).from(lineTable)
      .where(and(eq(lineTable.id, lineId), eq(lineTable.orgId, orgId))).limit(1);
    if (!filas[0]) throw new OmniError("not_found", "esa línea no existe");
  };

  /**
   * Avisa a las demás pestañas: una nota que escribe un compañero aparece en
   * el chat que tienes abierto sin recargar, que es justo cuando sirve.
   */
  const publicar = async (
    event: EventName, orgId: string, lineId: string, data: Record<string, unknown>,
  ): Promise<void> => {
    const envelope: EventEnvelope = {
      id: crypto.randomUUID(), event, orgId, lineId, timestamp: Date.now(), data,
    };
    await container.bus.publish(`org:${orgId}`, envelope);
    await container.dispatcher.dispatch(envelope);
  };

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/chats/{chatId}/notes", tags: ["notas internas"],
      summary: "Las notas internas de un chat, de la más nueva a la más vieja",
      description:
        "Solo las ve el equipo: nunca salen por el canal. Se paginan como el " +
        "historial, con `before`, para intercalarlas con los mensajes por fecha.",
      request: {
        params: Params,
        query: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(100),
          before: z.string().datetime().optional().describe("ISO-8601: lo anterior a esa marca"),
        }),
      },
      responses: {
        200: json(z.object({
          data: z.array(NoteSchema),
          meta: z.object({ nextBefore: z.string().nullable() }),
        }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId, chatId } = c.req.valid("param");
      const { limit, before } = c.req.valid("query");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(principal, routeOf("note.list"), { lineId, chat });
      await exigirLinea(lineId, principal.orgId);

      const filas = await db
        .select({ nota: internalNoteTable, authorName: userTable.name })
        .from(internalNoteTable)
        .leftJoin(userTable, eq(userTable.id, internalNoteTable.authorUserId))
        .where(and(
          eq(internalNoteTable.orgId, principal.orgId),
          eq(internalNoteTable.lineId, lineId),
          eq(internalNoteTable.chatId, chat.value),
          ...(before ? [lt(internalNoteTable.createdAt, new Date(before))] : []),
        ))
        .orderBy(desc(internalNoteTable.createdAt), desc(internalNoteTable.id))
        .limit(limit);

      const data = filas.map((f) => presentar({ ...f.nota, authorName: f.authorName }));
      return c.json({
        data,
        meta: { nextBefore: filas.length === limit ? data.at(-1)!.createdAt : null },
      }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/chats/{chatId}/notes", tags: ["notas internas"],
      summary: "Dejar una nota interna en un chat",
      description:
        "La ve el equipo dentro del chat, entre los mensajes; el cliente NO la ve " +
        "nunca. No pasa por el canal ni por la cola de salida: no hay transporte " +
        "que la pueda enviar.",
      request: {
        params: Params,
        ...body(z.object({ body: z.string().trim().min(1).max(4096) })),
      },
      responses: { 201: json(z.object({ data: NoteSchema }), "creada"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId, chatId } = c.req.valid("param");
      const { body: texto } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(principal, routeOf("note.create"), { lineId, chat });
      await exigirLinea(lineId, principal.orgId);

      const [creada] = await db.insert(internalNoteTable).values({
        id: `nota-${crypto.randomUUID()}`,
        orgId: principal.orgId, lineId, chatId: chat.value,
        authorUserId: principal.kind === "user" ? principal.userId : null,
        authorKeyId: principal.kind === "api-key" ? principal.apiKeyId : null,
        body: texto,
      }).returning();

      let nombre: string | null = null;
      if (principal.kind === "user") {
        const [u] = await db.select({ name: userTable.name }).from(userTable)
          .where(eq(userTable.id, principal.userId)).limit(1);
        nombre = u?.name ?? null;
      }
      const nota = presentar({ ...creada!, authorName: nombre });
      await publicar("note.created", principal.orgId, lineId, nota).catch(() => {});
      return c.json({ data: nota }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/lines/{lineId}/chats/{chatId}/notes/{noteId}",
      tags: ["notas internas"],
      summary: "Borrar una nota interna PROPIA",
      description:
        "Solo quien la escribió: una nota es lo que alguien dejó dicho, y que otro " +
        "pueda borrarla haría que nadie se fiara de lo que hay escrito.",
      request: { params: Params.extend({ noteId: z.string() }) },
      responses: { 200: json(z.object({ data: z.object({ ok: z.boolean() }) }), "borrada"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { lineId, chatId, noteId } = c.req.valid("param");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(principal, routeOf("note.delete"), { lineId, chat });

      const [nota] = await db.select().from(internalNoteTable)
        .where(and(
          eq(internalNoteTable.id, noteId),
          eq(internalNoteTable.orgId, principal.orgId),
          eq(internalNoteTable.lineId, lineId),
          eq(internalNoteTable.chatId, chat.value),
        ))
        .limit(1);
      if (!nota) throw new OmniError("not_found", "esa nota no existe");

      const propia = principal.kind === "user"
        ? nota.authorUserId === principal.userId
        : nota.authorKeyId === principal.apiKeyId;
      if (!propia) throw new OmniError("forbidden", "solo quien escribió una nota puede borrarla");

      await db.delete(internalNoteTable).where(eq(internalNoteTable.id, noteId));
      await publicar("note.deleted", principal.orgId, lineId, { id: noteId, chatId: chat.value })
        .catch(() => {});
      return c.json({ data: { ok: true } }, 200);
    },
  );
}
