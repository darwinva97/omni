import { pgTable, text, timestamp, boolean, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { orgTable, userTable } from "./identity.js";
import { lineTable } from "./lines.js";

/** Un conector agrupa credenciales y webhooks de una integración concreta. */
export const connectorTable = pgTable(
  "connector",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("connector_org_slug_idx").on(t.orgId, t.slug)],
);

/**
 * Claves de API con DOS ejes de alcance independientes.
 *
 * `allowedLines` y `allowedChats` son la diferencia entre poder apuntar un
 * agente de IA a una cuenta compartida y tener que darle todas las
 * conversaciones. Vacío significa "todas", incluidas las que se creen después.
 *
 * El secreto se guarda HASHEADO. En el gateway anterior viajaba en claro por la
 * base de datos y se imprimía en los logs en cada mensaje entrante.
 */
export const apiKeyTable = pgTable(
  "api_key",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgTable.id, { onDelete: "cascade" }),
    connectorId: text("connector_id").references(() => connectorTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Prefijo visible para reconocerla en el panel sin revelar el secreto. */
    prefix: text("prefix").notNull(),
    secretHash: text("secret_hash").notNull(),
    role: text("role").$type<"admin" | "operator" | "viewer">().notNull().default("operator"),
    allowedLines: jsonb("allowed_lines").$type<string[]>().notNull().default([]),
    allowedChats: jsonb("allowed_chats").$type<string[]>().notNull().default([]),
    /** Lista CIDR. Vacía = sin restricción de origen. */
    allowedCidrs: jsonb("allowed_cidrs").$type<string[]>().notNull().default([]),
    rateLimitPerMinute: integer("rate_limit_per_minute"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => userTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("api_key_prefix_idx").on(t.prefix),
    index("api_key_org_idx").on(t.orgId),
  ],
);

export const webhookEndpointTable = pgTable(
  "webhook_endpoint",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgTable.id, { onDelete: "cascade" }),
    connectorId: text("connector_id").references(() => connectorTable.id, { onDelete: "cascade" }),
    lineId: text("line_id").references(() => lineTable.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** Vacío significa TODOS los eventos. Ausente no existe: la columna no admite nulo. */
    events: jsonb("events").$type<string[]>().notNull().default([]),
    secret: text("secret").notNull(),
    /** HMAC-SHA256 sobre el cuerpo crudo. Apagarlo solo por compatibilidad. */
    hmacEnabled: boolean("hmac_enabled").notNull().default(true),
    headers: jsonb("headers").$type<Record<string, string>>(),
    enabled: boolean("enabled").notNull().default(true),
    maxAttempts: integer("max_attempts").notNull().default(5),
    timeoutMs: integer("timeout_ms").notNull().default(10000),
    /** Filtro declarativo evaluado ANTES de encolar la entrega. */
    filter: jsonb("filter").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("webhook_endpoint_org_idx").on(t.orgId), index("webhook_endpoint_line_idx").on(t.lineId)],
);

/**
 * Cada intento de entrega, consultable. Un webhook que falla tiene que ser
 * VISIBLE: en el gateway anterior el error solo iba a `console.error`.
 */
export const webhookDeliveryTable = pgTable(
  "webhook_delivery",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id").notNull().references(() => webhookEndpointTable.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    lineId: text("line_id"),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    attempt: integer("attempt").notNull().default(0),
    status: text("status").$type<"pending" | "delivered" | "failed" | "dead">().notNull().default("pending"),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("webhook_delivery_endpoint_idx").on(t.endpointId, t.createdAt.desc()),
    index("webhook_delivery_status_idx").on(t.orgId, t.status, t.createdAt.desc()),
  ],
);
