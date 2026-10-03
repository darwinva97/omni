import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError } from "@omni/shared";
import {
  authorize, canGrantRole, generateToken, hashPassword, hashToken,
  fakeVerify, verifyPassword, route as routeOf, type Role,
} from "@omni/core";
import { invitationTable, orgMemberTable, orgTable, sessionTable, userTable } from "@omni/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Container } from "../container.js";
import type { ApiEnv } from "./shared.js";
import { errors, json, body } from "./shared.js";
import { anotarFallo, exigirIntentoPermitido, olvidarFallos, origenDe } from "../intentos.js";

/**
 * Identidad de personas.
 *
 * Las sesiones viajan en una cookie `httpOnly`: el JavaScript del navegador
 * nunca ve la credencial, así que un XSS no puede robarla. En la base se
 * guarda el HASH del token, no el token, por la misma razón que las claves de
 * API: quien lea la base no puede suplantar a nadie.
 */

export const SESSION_COOKIE = "omni_session";
const SESSION_DAYS = 30;
const INVITATION_DAYS = 7;

const UserSchema = z.object({
  id: z.string(), email: z.string(), name: z.string(),
}).openapi("User");

export function registerIdentityRoutes(app: OpenAPIHono<ApiEnv>, container: Container): void {
  const db = container.dbh.db;

  const crearSesion = async (
    c: Parameters<Parameters<typeof app.openapi>[1]>[0],
    userId: string,
    orgId: string | null,
  ): Promise<void> => {
    const token = generateToken();
    await db.insert(sessionTable).values({
      id: await hashToken(token),
      userId,
      activeOrgId: orgId,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000),
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    });
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: container.config.PUBLIC_URL.startsWith("https"),
      // `lax` y no `none`: impide que otro sitio provoque peticiones
      // autenticadas desde el navegador de quien tiene sesión abierta.
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_DAYS * 24 * 3600,
    });
  };

  // ─────────────────────────────── alta
  app.openapi(
    createRoute({
      method: "post", path: "/v1/auth/register", tags: ["identidad"],
      summary: "Crear la cuenta propietaria y su organización",
      description:
        "Solo funciona mientras no exista ninguna organización: quien instala " +
        "crea la suya y el resto del equipo entra por invitación. Dejar el " +
        "registro abierto convertiría la instalación en pública.",
      request: { ...body(z.object({
        email: z.string().email(),
        name: z.string().min(1).max(120),
        password: z.string().min(12).max(256),
        orgName: z.string().min(1).max(120),
      })) },
      responses: { 201: json(z.object({ data: UserSchema }), "creada"), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const existentes = await db.select({ n: sql<number>`count(*)::int` }).from(orgTable);
      if ((existentes[0]?.n ?? 0) > 0) {
        throw new OmniError("forbidden", "ya hay una organización; el acceso es por invitación");
      }

      const userId = `u-${crypto.randomUUID()}`;
      const orgId = `o-${crypto.randomUUID()}`;
      const slug = input.orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) || "org";

      await db.insert(userTable).values({
        id: userId, email: input.email.toLowerCase(), name: input.name,
        passwordHash: await hashPassword(input.password), emailVerified: true,
      });
      await db.insert(orgTable).values({ id: orgId, name: input.orgName, slug });
      await db.insert(orgMemberTable).values({ orgId, userId, role: "owner" });

      await crearSesion(c, userId, orgId);
      return c.json({ data: { id: userId, email: input.email, name: input.name } }, 201);
    },
  );

  // ─────────────────────────────── entrar
  app.openapi(
    createRoute({
      method: "post", path: "/v1/auth/login", tags: ["identidad"],
      summary: "Iniciar sesión",
      request: { ...body(z.object({ email: z.string().email(), password: z.string() })) },
      responses: { 200: json(z.object({ data: UserSchema }), "sesión iniciada"), ...errors },
    }),
    async (c) => {
      const { email, password } = c.req.valid("json");

      /*
       * El freno va ANTES de tocar la base y antes del hash. Si fuera después,
       * un bloqueo costaría lo mismo que un intento legítimo y seguiría
       * sirviendo para consumir CPU del servidor.
       */
      const origen = origenDe(c.req.raw.headers as unknown as { get(n: string): string | undefined });
      const freno = { kv: container.kv };
      await exigirIntentoPermitido(freno, email, origen);

      const filas = await db.select().from(userTable)
        .where(eq(userTable.email, email.toLowerCase())).limit(1);
      const user = filas[0];

      /*
       * Cuando el correo no existe se gasta el mismo tiempo igualmente. Si no,
       * responder rápido revelaría que esa cuenta no está dada de alta, y eso
       * permite enumerar quién tiene acceso.
       */
      // Un correo que no existe también cuenta como fallo: si no, se podría
      // recorrer una lista de correos sin gastar intentos y averiguar cuáles
      // están dados de alta por la diferencia.
      if (!user?.passwordHash) {
        await fakeVerify();
        await anotarFallo(freno, email, origen);
        throw new OmniError("unauthenticated", "correo o contraseña incorrectos");
      }
      if (user.disabledAt) {
        await fakeVerify();
        await anotarFallo(freno, email, origen);
        throw new OmniError("unauthenticated", "correo o contraseña incorrectos");
      }
      if (!(await verifyPassword(password, user.passwordHash))) {
        await anotarFallo(freno, email, origen);
        throw new OmniError("unauthenticated", "correo o contraseña incorrectos");
      }
      await olvidarFallos(freno, email);

      const pertenencia = await db.select().from(orgMemberTable)
        .where(eq(orgMemberTable.userId, user.id)).limit(1);
      await crearSesion(c, user.id, pertenencia[0]?.orgId ?? null);
      return c.json({ data: { id: user.id, email: user.email, name: user.name } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/auth/logout", tags: ["identidad"],
      summary: "Cerrar la sesión",
      responses: { 200: json(z.object({ data: z.object({ ok: z.boolean() }) }), "cerrada"), ...errors },
    }),
    async (c) => {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) {
        // Se borra la fila, no solo la cookie: si no, el token seguiría siendo
        // válido para quien lo hubiera copiado.
        await db.delete(sessionTable).where(eq(sessionTable.id, await hashToken(token)));
      }
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ data: { ok: true } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get", path: "/v1/auth/me", tags: ["identidad"],
      summary: "Quién soy y en qué organización",
      responses: {
        200: json(z.object({ data: z.object({
          id: z.string(), email: z.string(), name: z.string(),
          orgId: z.string().nullable(), role: z.string().nullable(),
        }) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      if (principal.kind !== "user") {
        throw new OmniError("forbidden", "esta ruta es para sesiones de persona, no para claves de API");
      }
      const filas = await db.select().from(userTable).where(eq(userTable.id, principal.userId)).limit(1);
      const user = filas[0];
      if (!user) throw new OmniError("not_found", "la cuenta ya no existe");
      return c.json({
        data: {
          id: user.id, email: user.email, name: user.name,
          orgId: principal.orgId, role: principal.orgRole,
        },
      }, 200);
    },
  );

  // ─────────────────────────────── equipo
  app.openapi(
    createRoute({
      method: "get", path: "/v1/members", tags: ["identidad"],
      summary: "Quién está en la organización",
      responses: {
        200: json(z.object({ data: z.array(z.object({
          userId: z.string(), email: z.string(), name: z.string(), role: z.string(),
        })) }), "ok"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("org.members.list"));
      const filas = await db
        .select({
          userId: userTable.id, email: userTable.email,
          name: userTable.name, role: orgMemberTable.role,
        })
        .from(orgMemberTable)
        .innerJoin(userTable, eq(userTable.id, orgMemberTable.userId))
        .where(eq(orgMemberTable.orgId, principal.orgId));
      return c.json({ data: filas }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/invitations", tags: ["identidad"],
      summary: "Invitar a alguien a la organización",
      description: "El enlace de invitación se muestra UNA vez y caduca en siete días.",
      request: { ...body(z.object({
        email: z.string().email(),
        role: z.enum(["owner", "manager", "agent", "viewer"]).default("agent"),
      })) },
      responses: {
        201: json(z.object({ data: z.object({
          id: z.string(), email: z.string(), role: z.string(),
          token: z.string().describe("Sólo se muestra aquí"),
          expiresAt: z.string(),
        }) }), "creada"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("org.members.update"));

      const { email, role } = c.req.valid("json");
      // Nadie otorga un rol por encima del suyo.
      const propio: Role = principal.kind === "user" ? principal.orgRole : "owner";
      if (!canGrantRole(propio, role)) {
        throw new OmniError("forbidden", `no puedes otorgar el rol "${role}" teniendo "${propio}"`, {
          tuRol: propio, rolPedido: role,
        });
      }

      const token = generateToken();
      const id = `inv-${crypto.randomUUID()}`;
      const expiresAt = new Date(Date.now() + INVITATION_DAYS * 24 * 3600 * 1000);
      await db.insert(invitationTable).values({
        id, orgId: principal.orgId, email: email.toLowerCase(), role,
        tokenHash: await hashToken(token), expiresAt,
        invitedBy: principal.kind === "user" ? principal.userId : null,
      });
      return c.json({
        data: { id, email, role, token, expiresAt: expiresAt.toISOString() },
      }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post", path: "/v1/invitations/accept", tags: ["identidad"],
      summary: "Aceptar una invitación y crear la cuenta",
      request: { ...body(z.object({
        token: z.string().min(10),
        name: z.string().min(1).max(120),
        password: z.string().min(12).max(256),
      })) },
      responses: { 201: json(z.object({ data: UserSchema }), "cuenta creada"), ...errors },
    }),
    async (c) => {
      const { token, name, password } = c.req.valid("json");
      const filas = await db.select().from(invitationTable)
        .where(and(eq(invitationTable.tokenHash, await hashToken(token)), isNull(invitationTable.acceptedAt)))
        .limit(1);
      const inv = filas[0];
      if (!inv) throw new OmniError("not_found", "la invitación no existe o ya se usó");
      if (inv.expiresAt.getTime() <= Date.now()) {
        throw new OmniError("conflict", "la invitación ha caducado; pide otra");
      }

      const existente = await db.select({ id: userTable.id }).from(userTable)
        .where(eq(userTable.email, inv.email)).limit(1);

      let userId = existente[0]?.id;
      if (!userId) {
        userId = `u-${crypto.randomUUID()}`;
        await db.insert(userTable).values({
          id: userId, email: inv.email, name,
          passwordHash: await hashPassword(password), emailVerified: true,
        });
      }

      await db.insert(orgMemberTable)
        .values({ orgId: inv.orgId, userId, role: inv.role })
        .onConflictDoNothing();
      await db.update(invitationTable)
        .set({ acceptedAt: new Date() })
        .where(eq(invitationTable.id, inv.id));

      await crearSesion(c, userId, inv.orgId);
      return c.json({ data: { id: userId, email: inv.email, name } }, 201);
    },
  );
}
