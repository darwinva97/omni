import { pgTable, text, timestamp, boolean, integer, index, primaryKey } from "drizzle-orm/pg-core";
import { lineTable } from "./lines.js";

export const groupInfoTable = pgTable(
  "group_info",
  {
    lineId: text("line_id").notNull().references(() => lineTable.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    subject: text("subject").notNull(),
    description: text("description"),
    owner: text("owner"),
    /** Solo administradores pueden escribir. */
    announceOnly: boolean("announce_only").notNull().default(false),
    /** Solo administradores pueden cambiar los ajustes. */
    restricted: boolean("restricted").notNull().default(false),
    size: integer("size").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.lineId, t.address] })],
);

export const groupParticipantTable = pgTable(
  "group_participant",
  {
    lineId: text("line_id").notNull(),
    groupAddress: text("group_address").notNull(),
    participant: text("participant").notNull(),
    role: text("role").$type<"member" | "admin" | "superadmin">().notNull().default("member"),
  },
  (t) => [
    primaryKey({ columns: [t.lineId, t.groupAddress, t.participant] }),
    index("group_participant_lookup_idx").on(t.lineId, t.participant),
  ],
);

export const callLogTable = pgTable(
  "call_log",
  {
    id: text("id").primaryKey(),
    lineId: text("line_id").notNull().references(() => lineTable.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    fromAddress: text("from_address").notNull(),
    isVideo: boolean("is_video").notNull().default(false),
    status: text("status").notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("call_log_line_idx").on(t.lineId, t.at.desc())],
);

export const labelTable = pgTable(
  "label",
  {
    id: text("id").primaryKey(),
    lineId: text("line_id").notNull().references(() => lineTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    /**
     * Baileys no expone las etiquetas de forma estable, así que son NUESTRAS:
     * viven aquí y no dependen de que el protocolo las devuelva.
     */
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("label_line_idx").on(t.lineId)],
);

export const labelAssignmentTable = pgTable(
  "label_assignment",
  {
    labelId: text("label_id").notNull().references(() => labelTable.id, { onDelete: "cascade" }),
    lineId: text("line_id").notNull(),
    target: text("target").notNull(),
    targetKind: text("target_kind").$type<"chat" | "contact" | "conversation">().notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.labelId, t.target] }),
    index("label_assignment_target_idx").on(t.lineId, t.target),
  ],
);
