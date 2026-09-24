import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError, parseAddress, type LineId } from "@omni/shared";
import { assertCapability, type ChannelDriver } from "@omni/channels";
import { authorize, route as routeOf } from "@omni/core";
import { contactTable, lineTable, messageTable } from "@omni/db";
import { and, desc, eq } from "drizzle-orm";
import type { Container } from "../container.js";
import type { ApiEnv } from "./shared.js";
import { errors, json, body } from "./shared.js";

/**
 * Acciones sobre mensajes y chats.
 *
 * Todas siguen el mismo patrón: autorizar, comprobar que ESTE transporte sabe
 * hacerlo, actuar. La comprobación de capacidad es la que evita que pedir algo
 * que el driver no soporta acabe en un 500 o, peor, en un silencio.
 */
export function registerMessagingRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const driverOf = async (lineId: string): Promise<ChannelDriver> => {
    const rows = await container.dbh.db
      .select({ kind: lineTable.channelKind })
      .from(lineTable).where(eq(lineTable.id, lineId)).limit(1);
    if (!rows[0]) throw new OmniError("not_found", `la línea "${lineId}" no existe`);
    return container.runtime.driverFor(rows[0].kind);
  };

  const Ok = z.object({ data: z.object({ ok: z.boolean() }) });
  const lineChat = z.object({ lineId: z.string(), chatId: z.string() });

  app.openapi(
    createRoute({
      method: "patch", path: "/v1/lines/{lineId}/chats/{chatId}/messages/{messageId}",
      tags: ["mensajes"], summary: "Editar un mensaje ya enviado",
      description: "WhatsApp solo lo permite durante una ventana corta tras el envío.",
      request: {
        params: lineChat.extend({ messageId: z.string() }),
        ...body(z.object({ text: z.string().min(1).max(65536) })),
      },
      responses: { 200: json(Ok, "editado"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId, messageId } = c.req.valid("param");
      const { text } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("message.edit"), { lineId, chat });

      const driver = await driverOf(lineId);
      assertCapability(driver, "message.edit");
      await driver.editMessage!(lineId as LineId, chat, messageId, text);
      await container.dbh.db.update(messageTable)
        .set({ body: text, editedAt: new Date() })
        .where(and(eq(messageTable.lineId, lineId), eq(messageTable.providerMessageId, messageId)));
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/lines/{lineId}/chats/{chatId}/messages/{messageId}",
      tags: ["mensajes"], summary: "Borrar un mensaje para todos",
      request: { params: lineChat.extend({ messageId: z.string() }) },
      responses: { 200: json(Ok, "borrado"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId, messageId } = c.req.valid("param");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("message.delete"), { lineId, chat });

      const driver = await driverOf(lineId);
      assertCapability(driver, "message.delete");
      await driver.deleteMessage!(lineId as LineId, chat, messageId);
      // Se marca como borrado en vez de eliminar la fila: la auditoría necesita
      // saber que existió y quién lo quitó.
      await container.dbh.db.update(messageTable)
        .set({ deletedAt: new Date() })
        .where(and(eq(messageTable.lineId, lineId), eq(messageTable.providerMessageId, messageId)));
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/chats/{chatId}/messages/{messageId}/reaction",
      tags: ["mensajes"], summary: "Reaccionar a un mensaje",
      description: "Un emoji vacío retira la reacción, que es como lo expresa WhatsApp.",
      request: {
        params: lineChat.extend({ messageId: z.string() }),
        ...body(z.object({ emoji: z.string().max(8) })),
      },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId, messageId } = c.req.valid("param");
      const { emoji } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("message.react"), { lineId, chat });
      const driver = await driverOf(lineId);
      assertCapability(driver, "send.reaction");
      await driver.react!(lineId as LineId, chat, messageId, emoji);
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/chats/{chatId}/read",
      tags: ["chats"], summary: "Marcar mensajes como leídos",
      request: {
        params: lineChat,
        ...body(z.object({ messageIds: z.array(z.string()).min(1).max(200) })),
      },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId } = c.req.valid("param");
      const { messageIds } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("chat.markRead"), { lineId, chat });
      const driver = await driverOf(lineId);
      assertCapability(driver, "chat.read");
      await driver.markRead!(lineId as LineId, chat, messageIds);
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/chats/{chatId}/presence",
      tags: ["chats"], summary: "Mostrar que se está escribiendo o grabando",
      request: {
        params: lineChat,
        ...body(z.object({ presence: z.enum(["composing", "recording", "paused"]) })),
      },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId } = c.req.valid("param");
      const { presence } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("chat.presence"), { lineId, chat });
      const driver = await driverOf(lineId);
      assertCapability(driver, "chat.presence");
      await driver.setPresence!(lineId as LineId, chat, presence);
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/contacts",
      tags: ["contactos"], summary: "Contactos conocidos por esta línea",
      request: {
        params: z.object({ lineId: z.string() }),
        query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      },
      responses: {
        200: json(z.object({ data: z.array(z.object({
          address: z.string(), pushName: z.string().nullable(),
          savedName: z.string().nullable(), blocked: z.boolean(),
        })) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      await authorize(c.get("principal"), routeOf("contact.list"), { lineId });
      const rows = await container.dbh.db.select().from(contactTable)
        .where(eq(contactTable.lineId, lineId))
        .orderBy(desc(contactTable.updatedAt)).limit(limit);
      return c.json({ data: rows.map((r) => ({
        address: r.address, pushName: r.pushName, savedName: r.savedName, blocked: r.blocked,
      })) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/contacts/{address}/exists",
      tags: ["contactos"], summary: "Comprobar si un número está registrado",
      description:
        "Responde si ese número existe en la red del transporte. Con Cloud API " +
        "no hay forma de saberlo y se responde 422.",
      request: { params: z.object({ lineId: z.string(), address: z.string() }) },
      responses: {
        200: json(z.object({ data: z.object({
          exists: z.boolean(), address: z.string().nullable(),
        }) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId, address } = c.req.valid("param");
      await authorize(c.get("principal"), routeOf("contact.check"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "contact.check");
      const res = await driver.checkContact!(lineId as LineId, parseAddress(decodeURIComponent(address)));
      return c.json({ data: { exists: res.exists, address: res.address?.value ?? null } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/contacts/{address}/block",
      tags: ["contactos"], summary: "Bloquear o desbloquear un contacto",
      request: {
        params: z.object({ lineId: z.string(), address: z.string() }),
        ...body(z.object({ blocked: z.boolean().default(true) })),
      },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, address } = c.req.valid("param");
      const { blocked } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(address));
      await authorize(c.get("principal"), routeOf("contact.block"), { lineId, chat });
      const driver = await driverOf(lineId);
      assertCapability(driver, "contact.block");
      await container.dbh.db.insert(contactTable)
        .values({ id: `c-${lineId}-${chat.value}`, lineId, address: chat.value, blocked })
        .onConflictDoUpdate({
          target: [contactTable.lineId, contactTable.address],
          set: { blocked, updatedAt: new Date() },
        });
      await container.runtime.publish("contact.blocked", lineId, { address: chat.value, blocked });
      return c.json({ data: { ok: true } }, 200);
    },
  );
}
