import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError, parseAddress } from "@omni/shared";
import { authorize, route as routeOf } from "@omni/core";
import { labelAssignmentTable, labelTable } from "@omni/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Container } from "../container.js";
import type { ApiEnv } from "./shared.js";
import { errors, json, body } from "./shared.js";

/**
 * Etiquetas.
 *
 * Son NUESTRAS, no del protocolo. Baileys no las expone de forma estable y la
 * API oficial no las tiene, así que en vez de fingir que vienen de WhatsApp
 * viven aquí: funcionan igual en los cuatro transportes y no se rompen cuando
 * el protocolo cambia.
 *
 * Es el criterio que wapi-next ya había anotado como decisión pendiente.
 */

const LabelSchema = z.object({
  id: z.string(), name: z.string(), color: z.string().nullable(),
  usos: z.number(),
}).openapi("Label");

/** Colores admitidos. Una lista corta evita que cada etiqueta invente el suyo. */
const COLORES = ["gris", "rojo", "ámbar", "verde", "azul", "violeta"] as const;

export function registerLabelRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const db = container.dbh.db;

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/labels", tags: ["etiquetas"],
      summary: "Etiquetas de una línea, con cuántas veces se usa cada una",
      request: { params: z.object({ lineId: z.string() }) },
      responses: { 200: json(z.object({ data: z.array(LabelSchema) }), "ok"), ...errors },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      await authorize(c.get("principal"), routeOf("label.read"), { lineId });

      const filas = await db
        .select({
          id: labelTable.id, name: labelTable.name, color: labelTable.color,
          usos: sql<number>`count(${labelAssignmentTable.target})::int`,
        })
        .from(labelTable)
        .leftJoin(labelAssignmentTable, eq(labelAssignmentTable.labelId, labelTable.id))
        .where(eq(labelTable.lineId, lineId))
        .groupBy(labelTable.id, labelTable.name, labelTable.color)
        .orderBy(labelTable.name);
      return c.json({ data: filas }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines/{lineId}/labels", tags: ["etiquetas"],
      summary: "Crear una etiqueta",
      request: {
        params: z.object({ lineId: z.string() }),
        ...body(z.object({
          name: z.string().min(1).max(60),
          color: z.enum(COLORES).default("gris"),
        })),
      },
      responses: { 201: json(z.object({ data: LabelSchema }), "creada"), ...errors },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const { name, color } = c.req.valid("json");
      await authorize(c.get("principal"), routeOf("label.manage"), { lineId });

      const id = `lbl-${crypto.randomUUID()}`;
      const creada = await db.insert(labelTable)
        .values({ id, lineId, name, color })
        .onConflictDoNothing()
        .returning();
      if (creada.length === 0) {
        throw new OmniError("conflict", `ya hay una etiqueta llamada "${name}" en esta línea`);
      }
      return c.json({ data: { id, name, color, usos: 0 } }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch", path: "/v1/lines/{lineId}/labels/{labelId}", tags: ["etiquetas"],
      summary: "Renombrar una etiqueta o cambiar su color",
      description:
        "Lo que no venga se queda como estaba. Las conversaciones que la llevan " +
        "siguen llevándola: cambia el nombre, no la etiqueta.",
      request: {
        params: z.object({ lineId: z.string(), labelId: z.string() }),
        ...body(z.object({
          name: z.string().min(1).max(60).optional(),
          color: z.enum(COLORES).optional(),
        })),
      },
      responses: { 200: json(z.object({ data: LabelSchema }), "cambiada"), ...errors },
    }),
    async (c) => {
      const { lineId, labelId } = c.req.valid("param");
      const { name, color } = c.req.valid("json");
      await authorize(c.get("principal"), routeOf("label.manage"), { lineId });

      const cambios = {
        ...(name !== undefined ? { name } : {}),
        ...(color !== undefined ? { color } : {}),
      };
      if (Object.keys(cambios).length === 0) {
        throw new OmniError("validation_failed", "no hay nada que cambiar: manda `name` o `color`");
      }

      let filas;
      try {
        filas = await db.update(labelTable).set(cambios)
          .where(and(eq(labelTable.id, labelId), eq(labelTable.lineId, lineId)))
          .returning();
      } catch (e) {
        // El índice único por nombre: dos etiquetas iguales serían
        // indistinguibles en las pestañas del panel.
        // Drizzle envuelve el error del driver: el código de Postgres viene en
        // `cause`, y mirando solo arriba esto era un 500.
        const codigo = (e as { code?: string }).code
          ?? (e as { cause?: { code?: string } }).cause?.code;
        if (codigo === "23505") {
          throw new OmniError("conflict", `ya hay una etiqueta llamada "${name}" en esta línea`);
        }
        throw e;
      }
      const fila = filas[0];
      if (!fila) throw new OmniError("not_found", "esa etiqueta no existe en esta línea");

      const [uso] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(labelAssignmentTable)
        .where(eq(labelAssignmentTable.labelId, labelId));
      return c.json({
        data: { id: fila.id, name: fila.name, color: fila.color, usos: uso?.n ?? 0 },
      }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/lines/{lineId}/labels/{labelId}", tags: ["etiquetas"],
      summary: "Borrar una etiqueta y quitarla de donde estuviera",
      request: { params: z.object({ lineId: z.string(), labelId: z.string() }) },
      responses: { 200: json(z.object({ data: z.object({ ok: z.boolean() }) }), "borrada"), ...errors },
    }),
    async (c) => {
      const { lineId, labelId } = c.req.valid("param");
      await authorize(c.get("principal"), routeOf("label.manage"), { lineId });
      // Las asignaciones caen por cascada: una etiqueta borrada no puede seguir
      // pegada a conversaciones.
      const borrada = await db.delete(labelTable)
        .where(and(eq(labelTable.id, labelId), eq(labelTable.lineId, lineId)))
        .returning({ id: labelTable.id });
      if (borrada.length === 0) throw new OmniError("not_found", "esa etiqueta no existe en esta línea");
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put", path: "/v1/lines/{lineId}/chats/{chatId}/labels", tags: ["etiquetas"],
      summary: "Fijar las etiquetas de una conversación",
      description:
        "Reemplaza el conjunto entero: lo que no venga en la lista se quita. Es " +
        "más predecible que añadir y quitar de una en una, porque el resultado " +
        "no depende de lo que hubiera antes.",
      request: {
        params: z.object({ lineId: z.string(), chatId: z.string() }),
        ...body(z.object({ labelIds: z.array(z.string()).max(20) })),
      },
      responses: {
        200: json(z.object({ data: z.object({ labelIds: z.array(z.string()) }) }), "fijadas"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId, chatId } = c.req.valid("param");
      const { labelIds } = c.req.valid("json");
      const chat = parseAddress(decodeURIComponent(chatId));
      await authorize(c.get("principal"), routeOf("label.assign"), { lineId, chat });

      // Se comprueba que TODAS pertenezcan a esta línea antes de tocar nada: si
      // no, una etiqueta de otra línea acabaría pegada aquí.
      if (labelIds.length > 0) {
        // `inArray` y no `ANY(...)` a mano: interpolar el array en SQL crudo lo
        // manda como parámetros sueltos y Postgres rechaza la consulta.
        const suyas = await db.select({ id: labelTable.id }).from(labelTable)
          .where(and(eq(labelTable.lineId, lineId), inArray(labelTable.id, labelIds)));
        const encontradas = new Set(suyas.map((l) => l.id));
        const ajenas = labelIds.filter((id) => !encontradas.has(id));
        if (ajenas.length > 0) {
          throw new OmniError("validation_failed", "hay etiquetas que no son de esta línea", { ajenas });
        }
      }

      await db.delete(labelAssignmentTable)
        .where(and(eq(labelAssignmentTable.lineId, lineId), eq(labelAssignmentTable.target, chat.value)));
      if (labelIds.length > 0) {
        await db.insert(labelAssignmentTable).values(
          labelIds.map((labelId) => ({
            labelId, lineId, target: chat.value, targetKind: "chat" as const,
          })),
        );
      }

      await container.runtime.publish("label.updated", lineId, {
        target: chat.value, labelIds,
      });
      return c.json({ data: { labelIds } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/lines/{lineId}/labels/{labelId}/chats", tags: ["etiquetas"],
      summary: "Conversaciones con una etiqueta",
      request: { params: z.object({ lineId: z.string(), labelId: z.string() }) },
      responses: {
        200: json(z.object({ data: z.array(z.object({ target: z.string(), kind: z.string() })) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const { lineId, labelId } = c.req.valid("param");
      const principal = c.get("principal");
      await authorize(principal, routeOf("label.read"), { lineId });

      const filas = await db
        .select({ target: labelAssignmentTable.target, kind: labelAssignmentTable.targetKind })
        .from(labelAssignmentTable)
        .where(and(eq(labelAssignmentTable.lineId, lineId), eq(labelAssignmentTable.labelId, labelId)));

      // Una credencial acotada a chats ve solo los suyos: se filtra, no se rechaza.
      const visibles = principal.kind === "api-key" && principal.allowedChats.length > 0
        ? filas.filter((f) => principal.allowedChats.includes(f.target))
        : filas;
      return c.json({ data: visibles }, 200);
    },
  );
}
