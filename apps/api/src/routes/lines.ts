import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError, channelKinds } from "@omni/shared";
import { authorize, filterLines, route as routeOf } from "@omni/core";
import { apiKeyTable, auditEventTable, lineTable } from "@omni/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Container } from "../container.js";
import { mintApiKey } from "../keys.js";
import type { ApiEnv } from "./shared.js";
import { errors, json, body } from "./shared.js";

const LineSchema = z.object({
  id: z.string(), name: z.string(), slug: z.string(), channelKind: z.string(),
  address: z.string().nullable(), status: z.string(), enabled: z.boolean(),
  sendRatePerMinute: z.number(),
}).openapi("Line");

/** Alta y gestión de líneas, claves de API y bitácora. */
export function registerLineAdminRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const audit = async (
    c: { get: (k: "principal") => { orgId: string; kind: string }; req: { header: (h: string) => string | undefined } },
    action: string, targetKind: string, targetId: string, metadata: Record<string, unknown> = {},
  ): Promise<void> => {
    const p = c.get("principal") as { orgId: string; kind: string; apiKeyId?: string; userId?: string };
    await container.dbh.db.insert(auditEventTable).values({
      id: crypto.randomUUID(), orgId: p.orgId,
      actorUserId: p.userId ?? null, actorApiKeyId: p.apiKeyId ?? null,
      action, targetKind, targetId, metadata,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    });
  };

  app.openapi(
    createRoute({
      method: "post", path: "/v1/lines", tags: ["líneas"],
      summary: "Crear una línea",
      description:
        "Una línea es una cuenta de cualquier canal. `sendRatePerMinute` limita el " +
        "ritmo de envío: WhatsApp castiga la ráfaga más que el volumen, así que " +
        "subirlo mucho acerca el baneo.",
      request: { ...body(z.object({
        name: z.string().min(1).max(120),
        slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
        channelKind: z.enum(channelKinds),
        address: z.string().optional(),
        sendRatePerMinute: z.number().int().min(0).max(600).default(12),
        driverConfig: z.record(z.string(), z.unknown()).optional(),
      })) },
      responses: { 201: json(z.object({ data: LineSchema }), "creada"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const input = c.req.valid("json");
      await authorize(principal, routeOf("line.create"));

      const id = `line-${crypto.randomUUID()}`;
      const rows = await container.dbh.db.insert(lineTable).values({
        id, orgId: principal.orgId, name: input.name, slug: input.slug,
        channelKind: input.channelKind, address: input.address ?? null,
        sendRatePerMinute: input.sendRatePerMinute,
        driverConfig: input.driverConfig ?? null,
      }).onConflictDoNothing().returning();

      if (rows.length === 0) {
        throw new OmniError("conflict", `ya existe una línea con el identificador "${input.slug}"`);
      }
      await audit(c, "line.create", "line", id, { channelKind: input.channelKind });
      return c.json({ data: toLine(rows[0]!) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch", path: "/v1/lines/{lineId}", tags: ["líneas"],
      summary: "Cambiar los ajustes de una línea",
      request: {
        params: z.object({ lineId: z.string() }),
        ...body(z.object({
          name: z.string().min(1).max(120).optional(),
          enabled: z.boolean().optional(),
          sendRatePerMinute: z.number().int().min(0).max(600).optional(),
          driverConfig: z.record(z.string(), z.unknown()).optional(),
        })),
      },
      responses: { 200: json(z.object({ data: LineSchema }), "actualizada"), ...errors },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      const patch = c.req.valid("json");
      await authorize(c.get("principal"), routeOf("line.settings"), { lineId });

      const rows = await container.dbh.db.update(lineTable)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.sendRatePerMinute !== undefined ? { sendRatePerMinute: patch.sendRatePerMinute } : {}),
          ...(patch.driverConfig !== undefined ? { driverConfig: patch.driverConfig } : {}),
        })
        .where(and(eq(lineTable.id, lineId), isNull(lineTable.deletedAt)))
        .returning();
      if (rows.length === 0) throw new OmniError("not_found", `la línea "${lineId}" no existe`);
      await audit(c, "line.settings", "line", lineId, patch);
      return c.json({ data: toLine(rows[0]!) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/lines/{lineId}", tags: ["líneas"],
      summary: "Borrar una línea",
      description:
        "Cierra la conexión, borra las credenciales y marca la línea como borrada. " +
        "Los mensajes se conservan: la auditoría necesita saber qué pasó.",
      request: { params: z.object({ lineId: z.string() }) },
      responses: { 200: json(z.object({ data: z.object({ ok: z.boolean() }) }), "borrada"), ...errors },
    }),
    async (c) => {
      const { lineId } = c.req.valid("param");
      await authorize(c.get("principal"), routeOf("line.delete"), { lineId });
      await container.runtime.logout(lineId).catch(() => {});
      await container.dbh.db.update(lineTable)
        .set({ deletedAt: new Date(), enabled: false })
        .where(eq(lineTable.id, lineId));
      await audit(c, "line.delete", "line", lineId);
      return c.json({ data: { ok: true } }, 200);
    },
  );

  // ─────────────────────────────── claves de API
  app.openapi(
    createRoute({
      method: "post", path: "/v1/api-keys", tags: ["credenciales"],
      summary: "Acuñar una clave de API",
      description:
        "El secreto se muestra UNA vez y no se puede recuperar: en la base de datos " +
        "solo queda su hash. `allowedLines` y `allowedChats` vacíos significan todo; " +
        "una clave con `allowedChats` solo alcanza rutas marcadas como seguras para " +
        "chats, incluidas las que se añadan en el futuro.",
      request: { ...body(z.object({
        name: z.string().min(1).max(120),
        role: z.enum(["admin", "operator", "viewer"]).default("operator"),
        allowedLines: z.array(z.string()).default([]),
        allowedChats: z.array(z.string()).default([]),
        allowedCidrs: z.array(z.string()).default([]),
        expiresAt: z.string().datetime().optional(),
      })) },
      responses: {
        201: json(z.object({ data: z.object({
          id: z.string(), name: z.string(), role: z.string(), prefix: z.string(),
          apiKey: z.string().describe("Sólo se muestra aquí"),
        }) }), "creada"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const input = c.req.valid("json");
      await authorize(principal, routeOf("apikey.create"));

      const minted = await mintApiKey();
      const id = `k-${crypto.randomUUID()}`;
      await container.dbh.db.insert(apiKeyTable).values({
        id, orgId: principal.orgId, name: input.name, role: input.role,
        prefix: minted.prefix, secretHash: minted.secretHash,
        allowedLines: input.allowedLines, allowedChats: input.allowedChats,
        allowedCidrs: input.allowedCidrs,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: principal.kind === "user" ? principal.userId : null,
      });
      await audit(c, "apikey.create", "api_key", id, { role: input.role, name: input.name });
      return c.json({
        data: { id, name: input.name, role: input.role, prefix: minted.prefix, apiKey: minted.plaintext },
      }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/api-keys", tags: ["credenciales"],
      summary: "Listar claves, sin sus secretos",
      responses: {
        200: json(z.object({ data: z.array(z.object({
          id: z.string(), name: z.string(), role: z.string(), prefix: z.string(),
          allowedLines: z.array(z.string()), allowedChats: z.array(z.string()),
          lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable(),
        })) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("apikey.list"));
      const rows = await container.dbh.db.select().from(apiKeyTable)
        .where(eq(apiKeyTable.orgId, principal.orgId)).orderBy(desc(apiKeyTable.createdAt));
      return c.json({ data: rows.map((r) => ({
        id: r.id, name: r.name, role: r.role, prefix: r.prefix,
        allowedLines: r.allowedLines, allowedChats: r.allowedChats,
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
      })) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/api-keys/{keyId}", tags: ["credenciales"],
      summary: "Revocar una clave",
      request: { params: z.object({ keyId: z.string() }) },
      responses: { 200: json(z.object({ data: z.object({ ok: z.boolean() }) }), "revocada"), ...errors },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { keyId } = c.req.valid("param");
      await authorize(principal, routeOf("apikey.revoke"));

      // Revocar la última clave de administración dejaría la organización sin
      // forma de gestionarse. Se impide en vez de dejar que ocurra.
      const vivas = await container.dbh.db.select({ id: apiKeyTable.id, role: apiKeyTable.role })
        .from(apiKeyTable)
        .where(and(eq(apiKeyTable.orgId, principal.orgId), isNull(apiKeyTable.revokedAt)));
      const admins = vivas.filter((k) => k.role === "admin");
      if (admins.length === 1 && admins[0]!.id === keyId) {
        throw new OmniError("conflict", "es la última clave de administración viva; crea otra antes de revocarla");
      }

      const rows = await container.dbh.db.update(apiKeyTable)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeyTable.id, keyId), eq(apiKeyTable.orgId, principal.orgId)))
        .returning({ id: apiKeyTable.id });
      if (rows.length === 0) throw new OmniError("not_found", `no existe la clave "${keyId}"`);
      await audit(c, "apikey.revoke", "api_key", keyId);
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/audit", tags: ["credenciales"],
      summary: "Bitácora de auditoría",
      description: "Quién hizo qué, con qué credencial y desde dónde. Siempre activa.",
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) },
      responses: {
        200: json(z.object({ data: z.array(z.object({
          action: z.string(), targetKind: z.string().nullable(), targetId: z.string().nullable(),
          actorUserId: z.string().nullable(), actorApiKeyId: z.string().nullable(),
          ip: z.string().nullable(), at: z.string(),
        })) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      const { limit } = c.req.valid("query");
      await authorize(principal, routeOf("org.audit.list"));
      const rows = await container.dbh.db.select().from(auditEventTable)
        .where(eq(auditEventTable.orgId, principal.orgId))
        .orderBy(desc(auditEventTable.at)).limit(limit);
      return c.json({ data: rows.map((r) => ({
        action: r.action, targetKind: r.targetKind, targetId: r.targetId,
        actorUserId: r.actorUserId, actorApiKeyId: r.actorApiKeyId,
        ip: r.ip, at: r.at.toISOString(),
      })) }, 200);
    },
  );

  void filterLines;
}

function toLine(l: typeof lineTable.$inferSelect) {
  return {
    id: l.id, name: l.name, slug: l.slug, channelKind: l.channelKind,
    address: l.address, status: l.status, enabled: l.enabled,
    sendRatePerMinute: l.sendRatePerMinute,
  };
}
