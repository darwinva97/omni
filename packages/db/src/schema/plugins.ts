import { pgTable, text, timestamp, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { orgTable, userTable } from "./identity.js";

/** Plugins instalados por organización. */
export const pluginTable = pgTable(
  "plugin",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgTable.id, { onDelete: "cascade" }),
    /** El `id` del manifiesto: legible y estable entre versiones. */
    pluginId: text("plugin_id").notNull(),
    version: text("version").notNull(),
    /**
     * El manifiesto tal y como se validó al instalar.
     *
     * Si el fichero del disco cambia, manda lo que se aceptó: un plugin no
     * puede ampliarse los permisos editando su propio manifiesto.
     */
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    directory: text("directory").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Nace APAGADO: instalar no es autorizar. */
    enabled: boolean("enabled").notNull().default(false),
    status: text("status").notNull().default("parado"),
    lastError: text("last_error"),
    installedBy: text("installed_by").references(() => userTable.id, { onDelete: "set null" }),
    installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("plugin_org_plugin_idx").on(t.orgId, t.pluginId),
    index("plugin_enabled_idx").on(t.orgId),
  ],
);
