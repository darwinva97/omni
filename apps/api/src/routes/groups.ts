import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError, parseAddress, type LineId } from "@omni/shared";
import { assertCapability, type ChannelDriver, type GroupMetadata } from "@omni/channels";
import { authorize, route as routeOf } from "@omni/core";
import { groupInfoTable, groupParticipantTable, lineTable } from "@omni/db";
import { eq } from "drizzle-orm";
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
      const creador = driver as unknown as {
        createGroup?: (l: LineId, s: string, p: readonly string[]) => Promise<GroupMetadata>;
      };
      if (!creador.createGroup) {
        throw new OmniError("capability_unsupported", "este transporte no sabe crear grupos");
      }
      const meta = await creador.createGroup(lineId as LineId, subject, participants);
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
