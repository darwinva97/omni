import { pgTable, text, timestamp, boolean, integer, jsonb, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";
import type { ChannelKind } from "@omni/shared";
import { orgTable, userTable, type Role } from "./identity.js";

/**
 * Una LÍNEA es una cuenta de cualquier canal: un número de WhatsApp, un bot de
 * Telegram, un buzón de correo. Generalizar esto desde el principio es lo que
 * evita tener que reescribir el dominio cuando entra el segundo canal.
 */
export const lineTable = pgTable(
  "line",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgTable.id, { onDelete: "cascade" }),
    channelKind: text("channel_kind").$type<ChannelKind>().notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** La identidad en la red remota: teléfono, @usuario, dirección de correo. */
    address: text("address"),
    /** Configuración propia del driver: proxy, token de Cloud API, servidor SMTP. Cifrada. */
    driverConfig: jsonb("driver_config").$type<Record<string, unknown>>(),
    enabled: boolean("enabled").notNull().default(true),
    /** Último estado conocido, cacheado para el panel; la verdad la tiene el motor. */
    status: text("status").notNull().default("disconnected"),
    statusAt: timestamp("status_at", { withTimezone: true }).defaultNow().notNull(),
    /**
     * Ritmo máximo de envío, en mensajes por minuto. Es la defensa contra el
     * baneo: WhatsApp castiga las ráfagas, no el volumen total.
     */
    sendRatePerMinute: integer("send_rate_per_minute").notNull().default(12),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("line_org_slug_idx").on(t.orgId, t.slug),
    index("line_org_idx").on(t.orgId),
  ],
);

/** Acceso por línea, independiente del rol en la organización. */
export const lineMemberTable = pgTable(
  "line_member",
  {
    lineId: text("line_id").notNull().references(() => lineTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => userTable.id, { onDelete: "cascade" }),
    role: text("role").$type<Role>().notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.lineId, t.userId] }), index("line_member_user_idx").on(t.userId)],
);

/**
 * Credenciales del driver, CIFRADAS. En base de datos y no en disco, para que
 * un redespliegue reconecte en vez de pedir otro escaneo del QR.
 */
export const authStateTable = pgTable(
  "auth_state",
  {
    lineId: text("line_id").primaryKey().references(() => lineTable.id, { onDelete: "cascade" }),
    /** Caja sellada: nonce + ciphertext. La clave maestra vive fuera de la BD. */
    sealed: text("sealed").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

export const contactTable = pgTable(
  "contact",
  {
    id: text("id").primaryKey(),
    lineId: text("line_id").notNull().references(() => lineTable.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    pushName: text("push_name"),
    savedName: text("saved_name"),
    /** El @usuario de WhatsApp, sin la arroba. Tercero en el orden de nombres. */
    username: text("username"),
    /**
     * Su foto, como clave del almacén. Para los que escriben en un grupo y no
     * tienen conversación propia, que son los que no tienen fila en `chat`.
     */
    avatarKey: text("avatar_key"),
    avatarSyncedAt: timestamp("avatar_synced_at", { withTimezone: true }),
    blocked: boolean("blocked").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("contact_line_address_idx").on(t.lineId, t.address)],
);

/**
 * Mapeo LID↔teléfono.
 *
 * Es la tabla que permite responder "¿son la misma persona?" sin inventarlo.
 * Sin una fila aquí, un `@lid` se RECHAZA: adivinar a partir de los dígitos
 * confundiría a dos personas distintas y rompería el aislamiento entre chats.
 */
export const identityMapTable = pgTable(
  "identity_map",
  {
    lineId: text("line_id").notNull().references(() => lineTable.id, { onDelete: "cascade" }),
    lid: text("lid").notNull(),
    phone: text("phone").notNull(),
    /** De dónde salió el mapeo: lo dijo WhatsApp, o lo dedujimos de un mensaje. */
    source: text("source").notNull().default("server"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.lineId, t.lid] }),
    index("identity_map_phone_idx").on(t.lineId, t.phone),
  ],
);

export const chatTable = pgTable(
  "chat",
  {
    id: text("id").primaryKey(),
    lineId: text("line_id").notNull().references(() => lineTable.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    kind: text("kind").notNull(), // pn | lid | group | newsletter | broadcast
    title: text("title"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /**
     * Foto de perfil, como CLAVE del almacén y no como URL.
     *
     * La que da WhatsApp caduca en horas: guardarla sería tener fotos rotas la
     * semana siguiente. Vive en el chat y no en el contacto porque un grupo
     * también tiene foto y no tiene fila de contacto.
     */
    avatarKey: text("avatar_key"),
    avatarSyncedAt: timestamp("avatar_synced_at", { withTimezone: true }),
    unreadCount: integer("unread_count").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    muteUntil: timestamp("mute_until", { withTimezone: true }),
    ephemeralSeconds: integer("ephemeral_seconds"),
  },
  (t) => [
    uniqueIndex("chat_line_address_idx").on(t.lineId, t.address),
    index("chat_recent_idx").on(t.lineId, t.lastMessageAt),
  ],
);
