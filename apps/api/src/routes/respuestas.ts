import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError } from "@omni/shared";
import { authorize, route as routeOf } from "@omni/core";
import { quickReplyTable } from "@omni/db";
import { and, asc, eq } from "drizzle-orm";
import type { Container } from "../container.js";
import type { ApiEnv } from "./shared.js";
import { errors, json, body } from "./shared.js";

/**
 * Respuestas rápidas: textos de la organización con un atajo.
 *
 * En el panel, «/precios» al principio del campo ofrece el texto, que se puede
 * retocar antes de enviar. Son de la organización y no de cada persona: la
 * tarifa o el horario se escriben una vez y los dice igual todo el equipo.
 * Por eso cambiarlas es de quien gestiona, y usarlas de cualquiera.
 */

const RespuestaSchema = z.object({
  id: z.string(),
  /** Sin la barra y en minúsculas: «precios», que se escribe «/precios». */
  shortcut: z.string(),
  text: z.string(),
  updatedAt: z.string(),
}).openapi("RespuestaRapida");

const Atajo = z.string().max(64)
  .describe("Con o sin barra y con mayúsculas: se guarda sin barra y en minúsculas");

/**
 * El atajo, como se guarda.
 *
 * Se acepta con o sin barra y con mayúsculas, porque es como lo escribe la
 * gente; se guarda de una sola forma para que «/Precios» y «/precios» no sean
 * dos atajos que dicen cosas distintas. Sin espacios: el atajo termina donde
 * empieza el texto.
 *
 * Se comprueba aquí y no en el esquema para que el 422 diga QUÉ falla: el del
 * esquema solo dice «no valida», y quien escribió «dos palabras» no sabría
 * qué cambiar.
 */
function atajoDe(crudo: string): string {
  const atajo = crudo.trim().replace(/^\/+/, "").toLowerCase();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,31}$/u.test(atajo)) {
    throw new OmniError(
      "validation_failed",
      `«${crudo.trim()}» no vale como atajo: una sola palabra de hasta 32 letras o números, sin espacios (se admiten «-» y «_»)`,
    );
  }
  return atajo;
}
const Texto = z.string().trim().min(1).max(4096);

export function registerQuickReplyRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const db = container.dbh.db;
  const deFila = (f: typeof quickReplyTable.$inferSelect) => ({
    id: f.id, shortcut: f.shortcut, text: f.text, updatedAt: f.updatedAt.toISOString(),
  });
  const repetido = (atajo: string) =>
    new OmniError("conflict", `ya hay una respuesta rápida con el atajo «/${atajo}»`);

  app.openapi(
    createRoute({
      method: "get", path: "/v1/quick-replies", tags: ["respuestas rápidas"],
      summary: "Las respuestas rápidas de la organización, por atajo",
      responses: { 200: json(z.object({ data: z.array(RespuestaSchema) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("quickreply.list"));
      const filas = await db.select().from(quickReplyTable)
        .where(eq(quickReplyTable.orgId, principal.orgId))
        .orderBy(asc(quickReplyTable.shortcut));
      return c.json({ data: filas.map(deFila) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/quick-replies", tags: ["respuestas rápidas"],
      summary: "Crear una respuesta rápida",
      description: "El atajo se guarda sin la barra y en minúsculas, y es único: repetirlo da 409.",
      request: { ...body(z.object({ shortcut: Atajo, text: Texto })) },
      responses: { 201: json(z.object({ data: RespuestaSchema }), "creada"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("quickreply.manage"));
      const { text } = c.req.valid("json");
      const shortcut = atajoDe(c.req.valid("json").shortcut);
      const [creada] = await db.insert(quickReplyTable).values({
        id: `qr-${crypto.randomUUID()}`, orgId: principal.orgId, shortcut, text,
        createdBy: principal.kind === "user" ? principal.userId : null,
      }).onConflictDoNothing().returning();
      if (!creada) throw repetido(shortcut);
      return c.json({ data: deFila(creada) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch", path: "/v1/quick-replies/{id}", tags: ["respuestas rápidas"],
      summary: "Cambiar el atajo o el texto de una respuesta rápida",
      request: {
        params: z.object({ id: z.string() }),
        ...body(z.object({ shortcut: Atajo.optional(), text: Texto.optional() })),
      },
      responses: { 200: json(z.object({ data: RespuestaSchema }), "cambiada"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("quickreply.manage"));
      const { id } = c.req.valid("param");
      const pedido = c.req.valid("json");
      const cambios = {
        ...(pedido.shortcut !== undefined ? { shortcut: atajoDe(pedido.shortcut) } : {}),
        ...(pedido.text !== undefined ? { text: pedido.text } : {}),
      };
      const donde = and(eq(quickReplyTable.id, id), eq(quickReplyTable.orgId, principal.orgId));
      let cambiada;
      try {
        [cambiada] = await db.update(quickReplyTable)
          .set({ ...cambios, updatedAt: new Date() })
          .where(donde).returning();
      } catch (e) {
        // El índice único es quien sabe si el atajo nuevo ya lo tiene otra.
        if ((e as { cause?: { code?: string } }).cause?.code === "23505" && cambios.shortcut) {
          throw repetido(cambios.shortcut);
        }
        throw e;
      }
      if (!cambiada) throw new OmniError("not_found", `la respuesta rápida "${id}" no existe`);
      return c.json({ data: deFila(cambiada) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/quick-replies/{id}", tags: ["respuestas rápidas"],
      summary: "Borrar una respuesta rápida",
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(z.object({ data: z.object({ ok: z.boolean() }) }), "borrada"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("quickreply.manage"));
      const { id } = c.req.valid("param");
      const borradas = await db.delete(quickReplyTable)
        .where(and(eq(quickReplyTable.id, id), eq(quickReplyTable.orgId, principal.orgId)))
        .returning({ id: quickReplyTable.id });
      if (borradas.length === 0) throw new OmniError("not_found", `la respuesta rápida "${id}" no existe`);
      return c.json({ data: { ok: true } }, 200);
    },
  );
}
