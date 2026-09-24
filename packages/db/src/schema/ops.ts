import { pgTable, text, timestamp, integer, jsonb, index, primaryKey } from "drizzle-orm/pg-core";
import { orgTable, userTable } from "./identity.js";

/**
 * Bitácora de auditoría. SIEMPRE activa: quién creó, borró, conectó o cambió
 * un rol, con IP y agente. No se puede apagar desde la aplicación.
 */
export const auditEventTable = pgTable(
  "audit_event",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgTable.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => userTable.id, { onDelete: "set null" }),
    actorApiKeyId: text("actor_api_key_id"),
    action: text("action").notNull(),
    targetKind: text("target_kind"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("audit_event_org_idx").on(t.orgId, t.at.desc())],
);

/**
 * Cuotas. Apagadas por defecto: sin `BILLING_ENABLED` no se consulta ni la BD.
 * Al agotarse responde 402 con la métrica, el límite y el consumo —nunca 403,
 * porque el permiso era correcto y lo que faltaba era cupo.
 */
export const orgEntitlementTable = pgTable(
  "org_entitlement",
  {
    orgId: text("org_id").notNull().references(() => orgTable.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    limitValue: integer("limit_value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.metric] })],
);

export const usageCounterTable = pgTable(
  "usage_counter",
  {
    orgId: text("org_id").notNull().references(() => orgTable.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    /** Periodo en `YYYY-MM`, o `all` para las métricas sin ventana. */
    period: text("period").notNull(),
    used: integer("used").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.metric, t.period] })],
);
