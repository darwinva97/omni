import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError, RuleInput, RulePatch, parseAddress } from "@omni/shared";
import { authorize, route as routeOf } from "@omni/core";
import {
  automationRuleTable, automationRunTable, conversationTable, lineTable, orgMemberTable,
} from "@omni/db";
import { and, desc, eq } from "drizzle-orm";
import type { Container } from "../container.js";
import { presentarConversacion } from "../crm/conversaciones.js";
import type { ApiEnv } from "./shared.js";
import { errors, json, body } from "./shared.js";

/**
 * Conversaciones y reglas de automatización.
 *
 * Una regla nace APAGADA. Guardar una regla que empieza a actuar sola sobre
 * conversaciones reales en cuanto se pulsa "crear" asusta con razón: encender
 * es una decisión aparte.
 */
export const ConversationSchema = z.object({
  id: z.string(), lineId: z.string(), chatId: z.string(),
  status: z.string(), priority: z.string(),
  assigneeId: z.string().nullable(), subject: z.string().nullable(),
  openedAt: z.string(), lastMessageAt: z.string().nullable(),
  firstReplyAt: z.string().nullable(), resolvedAt: z.string().nullable(),
}).openapi("Conversation");

const RuleSchema = z.object({
  id: z.string(), name: z.string(), trigger: z.string(),
  conditions: z.array(z.unknown()), actions: z.array(z.unknown()),
  priority: z.number(), enabled: z.boolean(), lineId: z.string().nullable(),
}).openapi("AutomationRule");

const presentarConv = presentarConversacion;

const presentarRegla = (r: typeof automationRuleTable.$inferSelect) => ({
  id: r.id, name: r.name, trigger: r.trigger,
  conditions: r.conditions, actions: r.actions,
  priority: r.priority, enabled: r.enabled, lineId: r.lineId,
});

export function registerCrmRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const db = container.dbh.db;

  // ------------------------------------------------------------ conversaciones

  app.openapi(
    createRoute({
      method: "get", path: "/v1/conversations", tags: ["conversaciones"],
      summary: "La bandeja: conversaciones por estado",
      request: {
        query: z.object({
          status: z.enum(["open", "pending", "snoozed", "resolved"]).optional(),
          lineId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      responses: { 200: json(z.object({ data: z.array(ConversationSchema) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { status, lineId, limit } = c.req.valid("query");
      await authorize(principal, routeOf("conversation.list"), lineId ? { lineId } : {});

      const filas = await db.select().from(conversationTable)
        .where(and(
          eq(conversationTable.orgId, principal.orgId),
          ...(status ? [eq(conversationTable.status, status)] : []),
          ...(lineId ? [eq(conversationTable.lineId, lineId)] : []),
        ))
        .orderBy(desc(conversationTable.lastMessageAt))
        .limit(limit);
      return c.json({ data: filas.map(presentarConv) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch", path: "/v1/conversations/{conversationId}", tags: ["conversaciones"],
      summary: "Cambiar estado, prioridad, responsable o asunto",
      request: {
        params: z.object({ conversationId: z.string() }),
        ...body(z.object({
          status: z.enum(["open", "pending", "snoozed", "resolved"]).optional(),
          priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
          assigneeId: z.string().nullable().optional(),
          subject: z.string().max(200).nullable().optional(),
          snoozedUntil: z.string().datetime().nullable().optional(),
        })),
      },
      responses: { 200: json(z.object({ data: ConversationSchema }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { conversationId } = c.req.valid("param");
      const patch = c.req.valid("json");

      const filas = await db.select().from(conversationTable)
        .where(and(
          eq(conversationTable.id, conversationId),
          eq(conversationTable.orgId, principal.orgId),
        )).limit(1);
      const conv = filas[0];
      if (!conv) throw new OmniError("not_found", "esa conversación no existe");

      await authorize(principal, routeOf("conversation.update"), {
        lineId: conv.lineId, chat: parseAddress(conv.chatId),
      });

      if (patch.assigneeId) await exigirMiembro(patch.assigneeId, principal.orgId);

      /*
       * Reabrir una vieja cuando el cliente ya abrió otra chocaría con el
       * índice de «una abierta por chat» y salía un 500. Se dice qué pasa: la
       * que hay que atender es la nueva.
       */
      if (conv.status === "resolved" && patch.status && patch.status !== "resolved") {
        const viva = await container.conversaciones.viva(conv.lineId, conv.chatId);
        if (viva && viva.id !== conv.id) {
          throw new OmniError("conflict", "ese chat ya tiene otra conversación abierta", {
            openConversationId: viva.id,
          });
        }
      }

      const actualizada = await container.conversaciones.cambiar(conversationId, {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.priority ? { priority: patch.priority } : {}),
        ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.snoozedUntil !== undefined
          ? { snoozedUntil: patch.snoozedUntil ? new Date(patch.snoozedUntil) : null }
          : {}),
      });
      return c.json({ data: presentarConv(actualizada!) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/conversations", tags: ["conversaciones"],
      summary: "Abrir la conversación de un chat, o devolver la que ya está abierta",
      description:
        "Para atender un chat que todavía no tiene conversación —uno anterior a que " +
        "existieran, o uno al que aún no ha escrito nadie— sin esperar a su próximo " +
        "mensaje. Si ya hay una abierta, se devuelve esa: nunca hay dos. `assigneeId` " +
        "y `status`, si vienen, se aplican a la que resulte.",
      request: {
        ...body(z.object({
          lineId: z.string(),
          chatId: z.string(),
          assigneeId: z.string().nullable().optional(),
          status: z.enum(["open", "pending", "snoozed", "resolved"]).optional(),
        })),
      },
      responses: { 200: json(z.object({ data: ConversationSchema }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const input = c.req.valid("json");
      const chat = parseAddress(input.chatId);
      await authorize(principal, routeOf("conversation.update"), { lineId: input.lineId, chat });

      // La línea tiene que ser de esta organización: si no, se abriría un
      // expediente ajeno con solo conocer su identificador.
      const linea = await db.select({ id: lineTable.id }).from(lineTable)
        .where(and(eq(lineTable.id, input.lineId), eq(lineTable.orgId, principal.orgId)))
        .limit(1);
      if (!linea[0]) throw new OmniError("not_found", "esa línea no existe");
      if (input.assigneeId) await exigirMiembro(input.assigneeId, principal.orgId);

      const { conv } = await container.conversaciones.abrirOEncontrar(
        principal.orgId, input.lineId, chat.value, new Date(),
      );
      const cambio = {
        ...(input.status ? { status: input.status } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      };
      const final = Object.keys(cambio).length > 0
        ? await container.conversaciones.cambiar(conv.id, cambio)
        : conv;
      return c.json({ data: presentarConv(final!) }, 200);
    },
  );

  /**
   * Solo se asigna a alguien del equipo.
   *
   * La columna apunta a cualquier cuenta, y sin esto una conversación podía
   * quedar en manos de alguien de otra organización: invisible para todos,
   * porque nadie del equipo la vería en «Míos».
   */
  async function exigirMiembro(userId: string, orgId: string): Promise<void> {
    const filas = await db.select({ userId: orgMemberTable.userId }).from(orgMemberTable)
      .where(and(eq(orgMemberTable.userId, userId), eq(orgMemberTable.orgId, orgId)))
      .limit(1);
    if (!filas[0]) {
      throw new OmniError("validation_failed", "esa persona no es del equipo", { assigneeId: userId });
    }
  }

  // ------------------------------------------------------------ reglas

  app.openapi(
    createRoute({
      method: "get", path: "/v1/automations", tags: ["automatizaciones"],
      summary: "Reglas de la organización, en el orden en que se ejecutan",
      responses: { 200: json(z.object({ data: z.array(RuleSchema) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("automation.manage"));
      const filas = await db.select().from(automationRuleTable)
        .where(eq(automationRuleTable.orgId, principal.orgId))
        .orderBy(automationRuleTable.priority, automationRuleTable.createdAt);
      return c.json({ data: filas.map(presentarRegla) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/automations", tags: ["automatizaciones"],
      summary: "Crear una regla; nace APAGADA",
      description:
        "Las condiciones se cumplen TODAS o la regla no salta. Las acciones se " +
        "ejecutan en orden y `stop` corta la cadena para las de menor prioridad.",
      request: { ...body(RuleInput) },
      responses: { 201: json(z.object({ data: RuleSchema }), "creada"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const input = c.req.valid("json");
      await authorize(principal, routeOf("automation.manage"));

      const creada = await db.insert(automationRuleTable).values({
        id: `rule-${crypto.randomUUID()}`,
        orgId: principal.orgId, name: input.name, trigger: input.trigger,
        conditions: input.conditions, actions: input.actions,
        priority: input.priority, lineId: input.lineId ?? null, enabled: false,
        createdBy: principal.kind === "user" ? principal.userId : null,
      }).returning();
      return c.json({ data: presentarRegla(creada[0]!) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch", path: "/v1/automations/{ruleId}", tags: ["automatizaciones"],
      summary: "Editar una regla o encenderla",
      request: {
        params: z.object({ ruleId: z.string() }),
        ...body(RulePatch),
      },
      responses: { 200: json(z.object({ data: RuleSchema }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { ruleId } = c.req.valid("param");
      const patch = c.req.valid("json");
      await authorize(principal, routeOf("automation.manage"));

      const actualizada = await db.update(automationRuleTable)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.trigger !== undefined ? { trigger: patch.trigger } : {}),
          ...(patch.conditions !== undefined ? { conditions: patch.conditions } : {}),
          ...(patch.actions !== undefined ? { actions: patch.actions } : {}),
          ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
          ...(patch.lineId !== undefined ? { lineId: patch.lineId } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          updatedAt: new Date(),
        })
        .where(and(
          eq(automationRuleTable.id, ruleId),
          eq(automationRuleTable.orgId, principal.orgId),
        ))
        .returning();
      if (actualizada.length === 0) throw new OmniError("not_found", "esa regla no existe");
      return c.json({ data: presentarRegla(actualizada[0]!) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/automations/{ruleId}", tags: ["automatizaciones"],
      summary: "Borrar una regla y su historial de disparos",
      request: { params: z.object({ ruleId: z.string() }) },
      responses: { 200: json(z.object({ data: z.object({ ok: z.boolean() }) }), "ok"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { ruleId } = c.req.valid("param");
      await authorize(principal, routeOf("automation.manage"));
      const borradas = await db.delete(automationRuleTable)
        .where(and(
          eq(automationRuleTable.id, ruleId),
          eq(automationRuleTable.orgId, principal.orgId),
        ))
        .returning({ id: automationRuleTable.id });
      if (borradas.length === 0) throw new OmniError("not_found", "esa regla no existe");
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/automations/{ruleId}/runs", tags: ["automatizaciones"],
      summary: "Qué ha hecho una regla, incluido lo que falló",
      description:
        "El modo de fallo que hay que evitar es que una regla deje de funcionar " +
        "y nadie se entere. Aquí se ve, con el motivo.",
      request: {
        params: z.object({ ruleId: z.string() }),
        query: z.object({
          outcome: z.enum(["matched", "skipped", "failed"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      responses: {
        200: json(z.object({ data: z.array(z.object({
          id: z.string(), event: z.string(), outcome: z.string(),
          reason: z.string().nullable(), target: z.string().nullable(),
          actionsRun: z.array(z.unknown()), durationMs: z.number().nullable(),
          createdAt: z.string(),
        })) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { ruleId } = c.req.valid("param");
      const { outcome, limit } = c.req.valid("query");
      await authorize(principal, routeOf("automation.manage"));

      const filas = await db.select().from(automationRunTable)
        .where(and(
          eq(automationRunTable.ruleId, ruleId),
          eq(automationRunTable.orgId, principal.orgId),
          ...(outcome ? [eq(automationRunTable.outcome, outcome)] : []),
        ))
        .orderBy(desc(automationRunTable.createdAt))
        .limit(limit);

      return c.json({ data: filas.map((f) => ({
        id: f.id, event: f.event, outcome: f.outcome, reason: f.reason,
        target: f.target, actionsRun: f.actionsRun, durationMs: f.durationMs,
        createdAt: f.createdAt.toISOString(),
      })) }, 200);
    },
  );
}
