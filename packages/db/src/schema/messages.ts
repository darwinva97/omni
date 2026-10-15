import { pgTable, text, timestamp, boolean, integer, jsonb, index, primaryKey } from "drizzle-orm/pg-core";
import type { DeliveryState, MessageKind } from "@omni/shared";
import { lineTable } from "./lines.js";
import { userTable } from "./identity.js";

/**
 * Mensajes.
 *
 * La tabla que crece sin límite, así que se diseña para particionar por tiempo
 * DESDE EL PRINCIPIO: la clave primaria incluye `timestamp` porque Postgres lo
 * exige en una tabla particionada, y añadirlo después obliga a reescribirla entera.
 *
 * El índice `(line_id, chat_id, timestamp desc, id)` es el que sirve el scroll
 * de una conversación. Sin él toda vista de chat hace un recorrido secuencial.
 */
export const messageTable = pgTable(
  "message",
  {
    id: text("id").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    lineId: text("line_id").notNull(),
    chatId: text("chat_id").notNull(),
    /** Identificador asignado por la red remota. */
    providerMessageId: text("provider_message_id"),
    /** Idempotencia de extremo a extremo para los salientes. */
    clientMessageId: text("client_message_id"),
    senderAddress: text("sender_address").notNull(),
    fromMe: boolean("from_me").notNull(),
    kind: text("kind").$type<MessageKind>().notNull().default("text"),
    body: text("body"),
    /** Nodo original del canal, tal cual llegó. Nunca se reinterpreta al guardarlo. */
    raw: jsonb("raw"),
    state: text("state").$type<DeliveryState>().notNull().default("queued"),
    replyToId: text("reply_to_id"),
    mentions: jsonb("mentions").$type<string[]>(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),

    // medios
    mediaKey: text("media_key"),
    mediaMime: text("media_mime"),
    mediaSize: integer("media_size"),
    mediaFileName: text("media_file_name"),
    mediaMeta: jsonb("media_meta").$type<Record<string, unknown>>(),
    /** Hasta cuándo se conserva el binario. Nulo = política global de la organización. */
    mediaRetainUntil: timestamp("media_retain_until", { withTimezone: true }),

    /**
     * Trazabilidad de origen. Responde "¿quién mandó esto?" cuando el mensaje
     * salió de la plataforma: qué persona, o qué integración. Ninguno de los
     * gateways de referencia lo modela, y es lo primero que se pregunta al
     * auditar una conversación.
     */
    sentFromPlatform: boolean("sent_from_platform").notNull().default(false),
    sentByUserId: text("sent_by_user_id").references(() => userTable.id, { onDelete: "set null" }),
    sentByConnectorId: text("sent_by_connector_id"),
    failureReason: text("failure_reason"),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.timestamp] }),
    index("message_chat_idx").on(t.lineId, t.chatId, t.timestamp.desc(), t.id),
    // La búsqueda en toda la línea, de lo más nuevo atrás (migración 0011).
    index("message_linea_tiempo_idx").on(t.lineId, t.timestamp.desc()),
    index("message_provider_idx").on(t.lineId, t.providerMessageId),
    index("message_client_idx").on(t.lineId, t.clientMessageId),
    index("message_state_idx").on(t.lineId, t.state),
  ],
);

export const messageReceiptTable = pgTable(
  "message_receipt",
  {
    lineId: text("line_id").notNull().references(() => lineTable.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    /** En grupo, cada participante acusa por separado. */
    participant: text("participant").notNull(),
    state: text("state").$type<DeliveryState>().notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.lineId, t.providerMessageId, t.participant] })],
);

/**
 * Un mensaje destacado por alguien: la estrella de WhatsApp.
 *
 * Vive en Omni y no en el teléfono, así que funciona igual en todos los
 * transportes, y es de quien la puso —una persona del panel o una clave de
 * API—, como en WhatsApp es de cada cuenta. Sin clave foránea al mensaje:
 * `message` está particionada y su clave es (id, timestamp); `messageAt` es
 * la segunda mitad. Ver drizzle/0008_destacados.sql.
 */
export const starredMessageTable = pgTable(
  "starred_message",
  {
    ownerKind: text("owner_kind").$type<"user" | "api-key">().notNull(),
    ownerId: text("owner_id").notNull(),
    lineId: text("line_id").notNull().references(() => lineTable.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull(),
    messageId: text("message_id").notNull(),
    messageAt: timestamp("message_at", { withTimezone: true }).notNull(),
    starredAt: timestamp("starred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerKind, t.ownerId, t.lineId, t.messageId] }),
    index("starred_message_chat_idx").on(t.ownerKind, t.ownerId, t.lineId, t.chatId, t.starredAt.desc()),
  ],
);

export const reactionTable = pgTable(
  "reaction",
  {
    lineId: text("line_id").notNull().references(() => lineTable.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    reactor: text("reactor").notNull(),
    /** Cadena vacía = reacción retirada. Es como lo expresa WhatsApp. */
    emoji: text("emoji").notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.lineId, t.providerMessageId, t.reactor] })],
);

export const pollTable = pgTable(
  "poll",
  {
    id: text("id").primaryKey(),
    lineId: text("line_id").notNull().references(() => lineTable.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    chatId: text("chat_id").notNull(),
    question: text("question").notNull(),
    options: jsonb("options").$type<string[]>().notNull(),
    allowMultiple: boolean("allow_multiple").notNull().default(false),
    createdBy: text("created_by").notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("poll_line_msg_idx").on(t.lineId, t.providerMessageId)],
);

export const pollVoteTable = pgTable(
  "poll_vote",
  {
    pollId: text("poll_id").notNull().references(() => pollTable.id, { onDelete: "cascade" }),
    voter: text("voter").notNull(),
    selected: jsonb("selected").$type<number[]>().notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.pollId, t.voter] })],
);
