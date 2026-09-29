import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError, parseAddress, type LineId } from "@omni/shared";
import { assertCapability, type ChannelDriver, type GroupMetadata } from "@omni/channels";
import { authorize, route as routeOf } from "@omni/core";
import { groupInfoTable, groupParticipantTable, lineTable } from "@omni/db";
import { and, eq } from "drizzle-orm";
import type { Container } from "../container.js";
import type { ApiEnv } from "./shared.js";
import { errors, json, body } from "./shared.js";

const GroupSchema = z.object({
  address: z.string(), subject: z.string(), description: z.string().nullable(),
  owner: z.string().nullable(),
  participants: z.array(z.object({ address: z.string(), role: z.string() })),
}).openapi("Group");

const present = (g: GroupMetadata) => ({
  address: g.address.value,
  subject: g.subject,
  description: g.description ?? null,
  owner: g.owner?.value ?? null,
  participants: g.participants.map((p) => ({ address: p.address.value, role: p.role })),
});

/**
 * Grupos.
 *
 * La división importa: leer, renombrar y salir son seguras para una clave
 * acotada a chats; decidir QUIÉN pertenece al grupo no lo es. Un agente
 * acotado a un grupo puede trabajar en él, pero no meter ni echar a nadie.
 */
export function registerGroupRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const driverOf = async (lineId: string): Promise<ChannelDriver> => {
    const rows = await container.dbh.db
      .select({ kind: lineTable.channelKind })
      .from(lineTable).where(eq(lineTable.id, lineId)).limit(1);
    if (!rows[0]) throw new OmniError("not_found", `la línea "${lineId}" no existe`);
    return container.runtime.driverFor(rows[0].kind);
  };

  /** Refleja en la base lo que dice la red, que es la fuente de eventos. */
  const persist = async (lineId: string, g: GroupMetadata): Promise<void> => {
    await container.dbh.db.insert(groupInfoTable).values({
      lineId, address: g.address.value, subject: g.subject,
      description: g.description ?? null, owner: g.owner?.value ?? null,
      size: g.participants.length,
    }).onConflictDoUpdate({
      target: [groupInfoTable.lineId, groupInfoTable.address],
      set: { subject: g.subject, size: g.participants.length, syncedAt: new Date() },
    });
    await container.dbh.db.delete(groupParticipantTable)
      .where(eq(groupParticipantTable.groupAddress, g.address.value));
    if (g.participants.length > 0) {
      await container.dbh.db.insert(groupParticipantTable).values(
        g.participants.map((p) => ({
          lineId, groupAddress: g.address.value, participant: p.address.value, role: p.role,
        })),
      );
    }
  };

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/groups", tags: ["grupos"],
      summary: "Grupos a los que pertenece la línea",
      request: { params: z.object({ lineId: z.string() }) },
      responses: { 200: json(z.object({ data: z.array(GroupSchema) }), "ok"), ...errors },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const principal = c.get("principal");
      await authorize(principal, routeOf("chat.list"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "group.read");
      const grupos = await driver.listGroups!(lineId as LineId);
      // Una clave acotada ve sólo los grupos que le tocan: se filtra, no se rechaza.
      const visibles = principal.kind === "api-key" && principal.allowedChats.length > 0
        ? grupos.filter((g) => principal.allowedChats.includes(g.address.value))
        : grupos;
      return c.json({ data: visibles.map(present) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/groups/{groupId}", tags: ["grupos"],
      summary: "Datos y participantes de un grupo",
      request: { params: z.object({ lineId: z.string(), groupId: z.string() }) },
      responses: { 200: json(z.object({ data: GroupSchema }), "ok"), ...errors },
    }),
    async (c) => {
      const { lineId, groupId } = c.req.valid("param");
      const group = parseAddress(decodeURIComponent(groupId));
      await authorize(c.get("principal"), routeOf("group.read"), { lineId, chat: group });
      const driver = await driverOf(lineId);
      assertCapability(driver, "group.read");
      const meta = await driver.groupMetadata!(lineId as LineId, group);
      await persist(lineId, meta);
      return c.json({ data: present(meta) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/groups", tags: ["grupos"],
      summary: "Crear un grupo",
      request: {
        params: z.object({ lineId: z.string() }),
        ...body(z.object({
          subject: z.string().min(1).max(100),
          participants: z.array(z.string()).min(1).max(256),
        })),
      },
      responses: { 201: json(z.object({ data: GroupSchema }), "creado"), ...errors },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const { subject, participants } = c.req.valid("json");
      await authorize(c.get("principal"), routeOf("group.create"), { lineId });
      const driver = await driverOf(lineId);
      assertCapability(driver, "group.create");
      const meta = await driver.createGroup!(
        lineId as LineId, subject, participants.map((p) => parseAddress(p)),
      );
      await persist(lineId, meta);
      return c.json({ data: present(meta) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/groups/{groupId}/participants", tags: ["grupos"],
      summary: "Añadir, quitar, promover o degradar participantes",
      description:
        "Devuelve el resultado POR PARTICIPANTE: WhatsApp acepta a unos y rechaza a " +
        "otros en la misma petición, y decir sólo 'ok' escondería la mitad del resultado. " +
        "Esta ruta NO está permitida a una clave acotada a chats.",
      request: {
        params: z.object({ lineId: z.string(), groupId: z.string() }),
        ...body(z.object({
          action: z.enum(["add", "remove", "promote", "demote"]),
          participants: z.array(z.string()).min(1).max(50),
        })),
      },
      responses: {
        200: json(z.object({ data: z.array(z.object({
          address: z.string(), ok: z.boolean(), reason: z.string().optional(),
        })) }), "resultado por participante"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId, groupId } = c.req.valid("param");
      const { action, participants } = c.req.valid("json");
      const group = parseAddress(decodeURIComponent(groupId));
      await authorize(c.get("principal"), routeOf("group.participants"), { lineId, chat: group });
      const driver = await driverOf(lineId);
      assertCapability(driver, "group.participants");
      const res = await driver.updateParticipants!(
        lineId as LineId, group, participants.map((p) => parseAddress(p)), action,
      );
      return c.json({ data: res.map((r) => ({
        address: r.address.value, ok: r.ok, ...(r.reason ? { reason: r.reason } : {}),
      })) }, 200);
    },
  );
}

/** Acciones sobre un grupo que SÍ puede hacer una clave acotada a ese chat. */
export function registerGroupChatRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const driverOf = async (lineId: string): Promise<ChannelDriver> => {
    const rows = await container.dbh.db
      .select({ kind: lineTable.channelKind })
      .from(lineTable).where(eq(lineTable.id, lineId)).limit(1);
    if (!rows[0]) throw new OmniError("not_found", `la línea "${lineId}" no existe`);
    return container.runtime.driverFor(rows[0].kind);
  };
  const Ok = z.object({ data: z.object({ ok: z.boolean() }) });
  const Invite = z.object({ data: z.object({ code: z.string(), url: z.string() }) });

  app.openapi(
    createRoute({
      method: "patch", path: "/v1/lines/{lineId}/groups/{groupId}", tags: ["grupos"],
      summary: "Cambiar el asunto o la descripción de un grupo",
      request: {
        params: z.object({ lineId: z.string(), groupId: z.string() }),
        ...body(z.object({
          subject: z.string().min(1).max(100).optional(),
          description: z.string().max(2048).optional(),
        })),
      },
      responses: { 200: json(Ok, "actualizado"), ...errors },
    }),
    async (c) => {
      const { lineId, groupId } = c.req.valid("param");
      const patch = c.req.valid("json");
      const group = parseAddress(decodeURIComponent(groupId));
      await authorize(c.get("principal"), routeOf("group.update"), { lineId, chat: group });
      const driver = await driverOf(lineId);
      assertCapability(driver, "group.manage");

      /*
       * Primero WhatsApp, después nuestro espejo.
       *
       * Al revés —o solo el espejo, como estaba— el panel enseñaría el asunto
       * nuevo mientras el grupo sigue llamándose como antes. Una mentira
       * silenciosa es peor que un 422: nadie va a ir a comprobarla.
       */
      await driver.updateGroup!(lineId as LineId, group, patch);

      await container.dbh.db.update(groupInfoTable)
        .set({
          ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          syncedAt: new Date(),
        })
        .where(eq(groupInfoTable.address, group.value));
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/groups/{groupId}/leave", tags: ["grupos"],
      summary: "Salir de un grupo",
      request: { params: z.object({ lineId: z.string(), groupId: z.string() }) },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, groupId } = c.req.valid("param");
      const group = parseAddress(decodeURIComponent(groupId));
      await authorize(c.get("principal"), routeOf("group.leave"), { lineId, chat: group });
      const driver = await driverOf(lineId);
      assertCapability(driver, "group.manage");
      // Salir de verdad primero: borrar solo nuestras filas dejaba al usuario
      // dentro del grupo y fuera de su propia lista.
      await driver.leaveGroup!(lineId as LineId, group);
      await container.dbh.db.delete(groupInfoTable).where(eq(groupInfoTable.address, group.value));
      await container.dbh.db.delete(groupParticipantTable)
        .where(eq(groupParticipantTable.groupAddress, group.value));
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/groups/{groupId}/invite", tags: ["grupos"],
      summary: "Código de invitación vigente de un grupo",
      description:
        "Lo LEE, no lo rota: pedirlo dos veces devuelve el mismo. Para invalidar " +
        "el anterior está el POST, que devuelve uno nuevo.",
      request: { params: z.object({ lineId: z.string(), groupId: z.string() }) },
      responses: { 200: json(Invite, "código"), ...errors },
    }),
    async (c) => {
      const { lineId, groupId } = c.req.valid("param");
      const group = parseAddress(decodeURIComponent(groupId));
      await authorize(c.get("principal"), routeOf("group.invite"), { lineId, chat: group });
      const driver = await driverOf(lineId);
      assertCapability(driver, "group.invite");
      const code = await driver.groupInviteCode!(lineId as LineId, group);
      return c.json({ data: { code, url: `https://chat.whatsapp.com/${code}` } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/groups/{groupId}/invite", tags: ["grupos"],
      summary: "Rotar el código de invitación; el anterior deja de servir",
      request: { params: z.object({ lineId: z.string(), groupId: z.string() }) },
      responses: { 200: json(Invite, "código nuevo"), ...errors },
    }),
    async (c) => {
      const { lineId, groupId } = c.req.valid("param");
      const group = parseAddress(decodeURIComponent(groupId));
      await authorize(c.get("principal"), routeOf("group.invite"), { lineId, chat: group });
      const driver = await driverOf(lineId);
      assertCapability(driver, "group.invite");
      const code = await driver.revokeGroupInvite!(lineId as LineId, group);
      return c.json({ data: { code, url: `https://chat.whatsapp.com/${code}` } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/chats/{chatId}/archive", tags: ["chats"],
      summary: "Archivar o desarchivar una conversación",
      request: {
        params: z.object({ lineId: z.string(), chatId: z.string() }),
        ...body(z.object({ archived: z.boolean().default(true) })),
      },
      responses: { 200: json(Ok, "hecho"), ...errors },
    }),
    async (c) => {
      const { lineId, chatId } = c.req.valid("param");
      const { archived } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("chat.archive"), { lineId, chat });
      const { chatTable } = await import("@omni/db");
      const rows = await container.dbh.db.update(chatTable)
        .set({ archived })
        .where(and(eq(chatTable.lineId, lineId), eq(chatTable.address, chat.value)))
        .returning({ id: chatTable.id });
      if (rows.length === 0) throw new OmniError("not_found", "esa conversación no existe en esta línea");
      await container.runtime.publish("chat.archived", lineId, { chat: chat.value, archived });
      return c.json({ data: { ok: true } }, 200);
    },
  );
}
