import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError, RuleInput, RulePatch, parseAddress } from "@omni/shared";
import { authorize, route as routeOf } from "@omni/core";
import { automationRuleTable, automationRunTable, conversationTable } from "@omni/db";
import { and, desc, eq } from "drizzle-orm";
import type { Container } from "../container.js";
import type { ApiEnv } from "./shared.js";
import { errors, json, body } from "./shared.js";

/**
 * Conversaciones y reglas de automatización.
 *
 * Una regla nace APAGADA. Guardar una regla que empieza a actuar sola sobre
 * conversaciones reales en cuanto se pulsa "crear" asusta con razón: encender
 * es una decisión aparte.
 */
const ConversationSchema = z.object({
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

const presentarConv = (c: typeof conversationTable.$inferSelect) => ({
  id: c.id, lineId: c.lineId, chatId: c.chatId,
  status: c.status, priority: c.priority,
  assigneeId: c.assigneeId, subject: c.subject,
  openedAt: c.openedAt.toISOString(),
  lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
  firstReplyAt: c.firstReplyAt?.toISOString() ?? null,
  resolvedAt: c.resolvedAt?.toISOString() ?? null,
});

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

      const actualizada = await db.update(conversationTable)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.priority ? { priority: patch.priority } : {}),
          ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
          ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
          ...(patch.snoozedUntil !== undefined
            ? { snoozedUntil: patch.snoozedUntil ? new Date(patch.snoozedUntil) : null }
            : {}),
          // Resolverla deja constancia de cuándo; reabrirla la borra, porque
          // una fecha de resolución en una conversación abierta es una mentira.
          ...(patch.status === "resolved" ? { resolvedAt: new Date() } : {}),
          ...(patch.status && patch.status !== "resolved" ? { resolvedAt: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(conversationTable.id, conversationId))
        .returning();
      return c.json({ data: presentarConv(actualizada[0]!) }, 200);
    },
  );

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
