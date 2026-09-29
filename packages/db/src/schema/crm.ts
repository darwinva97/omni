import { pgTable, text, timestamp, boolean, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { orgTable, userTable } from "./identity.js";
import { lineTable } from "./lines.js";

/**
 * Una conversación NO es un chat.
 *
 * El chat es la dirección con la que se habla; la conversación es un episodio
 * de atención dentro de ella, con estado y responsable. Una misma persona
 * puede tener varias a lo largo del tiempo, y confundirlas haría imposible
 * decir cuántas se resolvieron o cuánto se tardó en la primera respuesta.
 */
export const conversationTable = pgTable(
  "conversation",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgTable.id, { onDelete: "cascade" }),
    lineId: text("line_id").notNull().references(() => lineTable.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    status: text("status").$type<"open" | "pending" | "snoozed" | "resolved">().notNull().default("open"),
    priority: text("priority").$type<"low" | "normal" | "high" | "urgent">().notNull().default("normal"),
    assigneeId: text("assignee_id").references(() => userTable.id, { onDelete: "set null" }),
    subject: text("subject"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /** Cuándo contestó por primera vez alguien de este lado. */
    firstReplyAt: timestamp("first_reply_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Una sola abierta por chat: dos repartirían los mensajes de una misma
    // persona entre dos expedientes.
    // El filtro `WHERE status <> 'resolved'` vive en la migración: Drizzle no
    // expresa índices parciales, y la migración es la fuente de verdad.
    uniqueIndex("conversation_abierta_idx").on(t.lineId, t.chatId),
    index("conversation_bandeja_idx").on(t.orgId, t.status, t.lastMessageAt),
    index("conversation_asignado_idx").on(t.assigneeId, t.status),
  ],
);

export const automationRuleTable = pgTable(
  "automation_rule",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    trigger: text("trigger").notNull(),
    conditions: jsonb("conditions").$type<unknown[]>().notNull().default([]),
    actions: jsonb("actions").$type<unknown[]>().notNull().default([]),
    /** Menor primero; empate por fecha de creación, para que el orden sea estable. */
    priority: integer("priority").notNull().default(100),
    /** Nace APAGADA: una regla que actúa sola en cuanto se guarda asusta con razón. */
    enabled: boolean("enabled").notNull().default(false),
    /** Acota la regla a una línea. Nulo = todas las de la organización. */
    lineId: text("line_id").references(() => lineTable.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => userTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("automation_rule_disparo_idx").on(t.orgId, t.trigger)],
);

/**
 * Cada disparo, con su resultado.
 *
 * Un fallo de automatización tiene que ser VISIBLE. El modo de fallo que
 * documentan las referencias es que la regla deje de funcionar y nadie se
 * entere en semanas, porque no hay ningún sitio donde mirar.
 */
export const automationRunTable = pgTable(
  "automation_run",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgTable.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull().references(() => automationRuleTable.id, { onDelete: "cascade" }),
    lineId: text("line_id"),
    target: text("target"),
    event: text("event").notNull(),
    outcome: text("outcome").$type<"matched" | "skipped" | "failed">().notNull(),
    reason: text("reason"),
    actionsRun: jsonb("actions_run").$type<unknown[]>().notNull().default([]),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("automation_run_regla_idx").on(t.ruleId, t.createdAt)],
);
