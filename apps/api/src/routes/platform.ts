import { timingSafeEqual } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { OmniError } from "@omni/shared";
import { apiKeyTable, lineTable, orgTable } from "@omni/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Container } from "../container.js";
import { problem } from "../http.js";
import { mintApiKey } from "../keys.js";

/**
 * Aprovisionamiento para una plataforma que aloja Omni para sus clientes.
 *
 * Omni crea UNA organización por instalación (`/v1/auth/register` se cierra en
 * cuanto existe la primera). Una plataforma de hosting que quiere dar WhatsApp a
 * cada cliente necesita una organización por cliente, y que nadie más pueda
 * crearlas: por eso va aparte, con su propio token (`OMNI_PLATFORM_TOKEN`), y
 * NO pasa por el middleware de `/v1` —igual que `/mcp`—, sino por su propia
 * comprobación. Sin el token configurado, estas rutas no existen.
 *
 * - `GET  /platform/ping`: ¿el token vale? (para que la plataforma lo compruebe al guardarlo).
 * - `POST /platform/orgs`: crea (o encuentra) la organización del cliente por su
 *   identificador externo y acuña una clave de administración nueva, que se
 *   enseña UNA vez. Las claves anteriores de la plataforma para esa organización
 *   se revocan: siempre hay una sola viva.
 * - `DELETE /platform/orgs/{externalId}`: baja del cliente. Revoca sus claves y
 *   cierra y borra (en blando) sus líneas; los mensajes se conservan, como en
 *   `DELETE /v1/lines/{lineId}`.
 */
const EXTERNAL_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const NOMBRE_CLAVE = "plataforma";

export function registerPlatformRoutes(app: OpenAPIHono<any>, container: Container): void {
  const token = container.config.OMNI_PLATFORM_TOKEN;
  if (!token) return;
  const esperado = Buffer.from(token);

  const exigirToken = (header: string | undefined): void => {
    const dado = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7).trim() : "");
    // Comparación en tiempo constante; con longitudes distintas se compara
    // contra sí mismo para gastar lo mismo y se rechaza igual.
    const ok = dado.length === esperado.length
      ? timingSafeEqual(dado, esperado)
      : (timingSafeEqual(esperado, esperado), false);
    if (!ok) throw new OmniError("unauthenticated", "token de plataforma inválido");
  };
  const db = container.dbh.db;
  const slugDe = (externalId: string) => `ext-${externalId}`;

  app.get("/platform/ping", async (c) => {
    try {
      exigirToken(c.req.header("authorization"));
      return c.json({ data: { ok: true } }, 200);
    } catch (e) {
      return problem(c, e);
    }
  });

  app.post("/platform/orgs", async (c) => {
    try {
      exigirToken(c.req.header("authorization"));
      const input = z.object({
        externalId: z.string().regex(EXTERNAL_ID),
        name: z.string().min(1).max(120),
      }).safeParse(await c.req.json().catch(() => null));
      if (!input.success) {
        throw new OmniError("validation_failed", "se espera { externalId, name }", { issues: input.error.issues });
      }
      const { externalId, name } = input.data;
      const slug = slugDe(externalId);

      let org = (await db.select().from(orgTable).where(eq(orgTable.slug, slug)).limit(1))[0];
      if (!org) {
        const id = `o-${crypto.randomUUID()}`;
        await db.insert(orgTable).values({ id, name, slug }).onConflictDoNothing();
        org = (await db.select().from(orgTable).where(eq(orgTable.slug, slug)).limit(1))[0]!;
      }

      // Una sola clave de la plataforma viva por organización.
      await db.update(apiKeyTable)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeyTable.orgId, org.id), eq(apiKeyTable.name, NOMBRE_CLAVE), isNull(apiKeyTable.revokedAt)));
      const minted = await mintApiKey();
      await db.insert(apiKeyTable).values({
        id: `k-${crypto.randomUUID()}`, orgId: org.id, name: NOMBRE_CLAVE, role: "admin",
        prefix: minted.prefix, secretHash: minted.secretHash,
        allowedLines: [], allowedChats: [], allowedCidrs: [],
        expiresAt: null, createdBy: null,
      });
      return c.json({ data: { orgId: org.id, apiKey: minted.plaintext } }, 201);
    } catch (e) {
      return problem(c, e);
    }
  });

  app.delete("/platform/orgs/:externalId", async (c) => {
    try {
      exigirToken(c.req.header("authorization"));
      const externalId = c.req.param("externalId");
      if (!EXTERNAL_ID.test(externalId)) throw new OmniError("validation_failed", "identificador externo inválido");
      const org = (await db.select().from(orgTable).where(eq(orgTable.slug, slugDe(externalId))).limit(1))[0];
      if (!org) return c.json({ data: { ok: true } }, 200);
      await db.update(apiKeyTable)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeyTable.orgId, org.id), isNull(apiKeyTable.revokedAt)));
      const lineas = await db.select({ id: lineTable.id }).from(lineTable)
        .where(and(eq(lineTable.orgId, org.id), isNull(lineTable.deletedAt)));
      for (const l of lineas) {
        await container.runtime.logout(l.id).catch(() => {});
        await db.update(lineTable).set({ deletedAt: new Date(), enabled: false }).where(eq(lineTable.id, l.id));
      }
      return c.json({ data: { ok: true } }, 200);
    } catch (e) {
      return problem(c, e);
    }
  });
}
