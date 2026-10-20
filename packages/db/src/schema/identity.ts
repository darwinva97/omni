import { pgTable, text, timestamp, boolean, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

/** Roles. El MISMO triplete sirve para la organización y para cada línea. */
export type Role = "owner" | "manager" | "agent" | "viewer";

export const orgTable = pgTable("org", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const userTable = pgTable(
  "app_user",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    name: text("name").notNull(),
    /** scrypt. Nulo cuando la cuenta entra solo por proveedor externo. */
    passwordHash: text("password_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("app_user_email_idx").on(t.email)],
);

export const orgMemberTable = pgTable(
  "org_member",
  {
    orgId: text("org_id").notNull().references(() => orgTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => userTable.id, { onDelete: "cascade" }),
    role: text("role").$type<Role>().notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index("org_member_user_idx").on(t.userId)],
);

/** Sesión de navegador. Va en cookie httpOnly: el bundle nunca ve una credencial. */
export const sessionTable = pgTable(
  "app_session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => userTable.id, { onDelete: "cascade" }),
    activeOrgId: text("active_org_id").references(() => orgTable.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    /** Solo en sesiones abiertas con OpenID Connect: para cerrarlas cuando el proveedor avise. */
    oidcSubject: text("oidc_subject"),
    oidcSessionId: text("oidc_session_id"),
    /** Refresh token del proveedor, sellado con la clave maestra; se renueva para revalidar. */
    oidcRefreshToken: text("oidc_refresh_token"),
    oidcCheckedAt: timestamp("oidc_checked_at", { withTimezone: true }),
  },
  (t) => [index("app_session_user_idx").on(t.userId), index("app_session_expiry_idx").on(t.expiresAt)],
);

export const invitationTable = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => orgTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").$type<Role>().notNull().default("agent"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by").references(() => userTable.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("invitation_org_idx").on(t.orgId), uniqueIndex("invitation_token_idx").on(t.tokenHash)],
);
