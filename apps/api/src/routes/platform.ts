import { randomBytes, timingSafeEqual } from "node:crypto";
import { setCookie } from "hono/cookie";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { OmniError } from "@omni/shared";
import { apiKeyTable, lineTable, orgMemberTable, orgTable, sessionTable, userTable } from "@omni/db";
import { generateToken, hashToken } from "@omni/core";
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
 * - `POST /platform/orgs/{externalId}/acceso`: un enlace de UN solo uso (60 s) para
 *   que el cliente entre al panel web de su organización sin otro login. La
 *   organización tiene un usuario propio de la plataforma (rol owner, sin
 *   contraseña: sólo se entra así). `GET /platform/entrar?codigo=` lo canjea
 *   por la sesión de siempre y lleva al panel con el tema y el acento que pasó
 *   la plataforma.
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

  /*
   * Códigos de entrada: en memoria (la API es un solo proceso, `Recreate`) y de
   * un solo uso. Lo que se guarda es el hash: quien vuelque la memoria no puede
   * usarlos.
   */
  const codigos = new Map<string, { userId: string; orgId: string; vence: number; tema: string; acento: string; marco: string; marcoClaro: boolean }>();
  const ACENTO = /^(#[0-9a-fA-F]{3,8}|oklch\([0-9.% ]{5,40}\)|rgb\([0-9., %]{5,40}\))$/;

  app.post("/platform/orgs/:externalId/acceso", async (c) => {
    try {
      exigirToken(c.req.header("authorization"));
      const externalId = c.req.param("externalId");
      if (!EXTERNAL_ID.test(externalId)) throw new OmniError("validation_failed", "identificador externo inválido");
      const org = (await db.select().from(orgTable).where(eq(orgTable.slug, slugDe(externalId))).limit(1))[0];
      if (!org) throw new OmniError("not_found", "esa organización no existe");
      const cuerpo = (await c.req.json().catch(() => ({}))) as { tema?: string; acento?: string; marco?: string; marcoClaro?: boolean };

      // El usuario de la plataforma en esa organización: uno por organización.
      const userId = `u-plat-${org.id}`;
      await db.insert(userTable).values({
        id: userId, email: `${org.id}@plataforma.omni.invalid`, name: "Plataforma", emailVerified: true, passwordHash: null,
      }).onConflictDoNothing();
      await db.insert(orgMemberTable).values({ orgId: org.id, userId, role: "owner" }).onConflictDoNothing();

      const ahora = Date.now();
      for (const [k, v] of codigos) if (v.vence <= ahora) codigos.delete(k);
      const codigo = randomBytes(24).toString("base64url");
      codigos.set(await hashToken(codigo), {
        userId, orgId: org.id, vence: ahora + 60_000,
        tema: cuerpo.tema === "oscuro" || cuerpo.tema === "claro" ? cuerpo.tema : "",
        acento: typeof cuerpo.acento === "string" && ACENTO.test(cuerpo.acento.trim()) ? cuerpo.acento.trim() : "",
        marco: typeof cuerpo.marco === "string" && ACENTO.test(cuerpo.marco.trim()) ? cuerpo.marco.trim() : "",
        marcoClaro: cuerpo.marcoClaro === true,
      });
      const base = container.config.PUBLIC_URL.replace(/\/$/, "");
      return c.json({ data: { url: `${base}/platform/entrar?codigo=${codigo}` } }, 200);
    } catch (e) {
      return problem(c, e);
    }
  });

  app.get("/platform/entrar", async (c) => {
    const codigo = c.req.query("codigo") ?? "";
    const clave = codigo ? await hashToken(codigo) : "";
    const entrada = codigos.get(clave);
    codigos.delete(clave);
    if (!entrada || entrada.vence <= Date.now()) {
      return c.html(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">` +
          `<p>El enlace caducó o ya se usó. Vuelve a abrir WhatsApp desde tu panel.</p></body>`,
        410,
      );
    }
    const token = generateToken();
    const segundos = 12 * 3600;
    await db.insert(sessionTable).values({
      id: await hashToken(token),
      userId: entrada.userId,
      activeOrgId: entrada.orgId,
      expiresAt: new Date(Date.now() + segundos * 1000),
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    });
    /* Esta entrada se usa DENTRO de la plataforma (un iframe). Con `SameSite=Lax` el navegador no
       manda la cookie en un iframe de otro sitio (el panel de un revendedor con su dominio) ni en
       los que aíslan las de terceros (Brave, Safari): Omni enseñaba su pantalla de contraseña, que
       el cliente no tiene. `None` + `Partitioned` (CHIPS) la deja en el marco y sólo para ese panel. */
    const https = container.config.PUBLIC_URL.startsWith("https");
    if (https)
      setCookie(c, "omni_session", token, { httpOnly: true, secure: true, sameSite: "None", partitioned: true, path: "/", maxAge: segundos });
    else setCookie(c, "omni_session", token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: segundos });
    const q = new URLSearchParams();
    if (entrada.tema) q.set("tema", entrada.tema);
    if (entrada.acento) q.set("acento", entrada.acento);
    if (entrada.marco) {
      q.set("marco", entrada.marco);
      q.set("marcoClaro", entrada.marcoClaro ? "1" : "0");
    }
    return c.redirect(`/${q.size ? `?${q}` : ""}`, 302);
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
