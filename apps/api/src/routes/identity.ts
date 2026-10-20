import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { OmniError } from "@omni/shared";
import {
  authorize, canGrantRole, generateToken, hashPassword, hashToken,
  fakeVerify, verifyPassword, route as routeOf, type Role,
} from "@omni/core";
import {
  invitationTable, lineMemberTable, lineTable, orgMemberTable, orgTable, sessionTable, userTable,
} from "@omni/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { Container } from "../container.js";
import {
  aleatorio, destinoSeguro, OidcClient, OidcError, type OidcIdentity, type OidcRechazo,
} from "../oidc.js";
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
    c: Context<ApiEnv>,
    userId: string,
    orgId: string | null,
    /** Sesión abierta con el proveedor OIDC: dura menos y se cierra cuando él avise. */
    oidc?: { subject: string; sessionId: string | null },
  ): Promise<void> => {
    const token = generateToken();
    const segundos = oidc ? container.config.OIDC_SESSION_HOURS * 3600 : SESSION_DAYS * 24 * 3600;
    await db.insert(sessionTable).values({
      id: await hashToken(token),
      userId,
      activeOrgId: orgId,
      expiresAt: new Date(Date.now() + segundos * 1000),
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      oidcSubject: oidc?.subject ?? null,
      oidcSessionId: oidc?.sessionId ?? null,
    });
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: container.config.PUBLIC_URL.startsWith("https"),
      // `lax` y no `none`: impide que otro sitio provoque peticiones
      // autenticadas desde el navegador de quien tiene sesión abierta.
      sameSite: "Lax",
      path: "/",
      maxAge: segundos,
    });
  };

  /** Con la contraseña apagada, todo lo que la crea o la usa queda cerrado. */
  const exigirContrasenaActiva = (): void => {
    if (!container.config.PASSWORD_LOGIN_ENABLED) {
      throw new OmniError("forbidden", `la entrada con contraseña está desactivada; entra con ${container.config.OIDC_DISPLAY_NAME}`);
    }
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
      exigirContrasenaActiva();
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
      exigirContrasenaActiva();
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

  /**
   * Comprobaciones comunes a cambiar el rol y quitar a alguien: que esté en la
   * organización y que quien lo hace no esté por debajo de él. Si no, un
   * `manager` podría degradar al `owner` y quedarse con la organización.
   */
  const miembroGestionable = async (
    principal: { kind: string; orgId: string; orgRole?: Role },
    userId: string,
  ): Promise<{ role: Role; propio: Role }> => {
    const propio: Role = principal.kind === "user" && principal.orgRole ? principal.orgRole : "owner";
    const filas = await db.select({ role: orgMemberTable.role }).from(orgMemberTable)
      .where(and(eq(orgMemberTable.orgId, principal.orgId), eq(orgMemberTable.userId, userId))).limit(1);
    const actual = filas[0];
    if (!actual) throw new OmniError("not_found", "esa persona no está en la organización");
    if (!canGrantRole(propio, actual.role)) {
      throw new OmniError("forbidden", `no puedes gestionar a alguien con rol "${actual.role}" teniendo "${propio}"`);
    }
    return { role: actual.role, propio };
  };

  /** Nunca se deja la organización sin dueño: nadie podría gestionarla después. */
  const exigirOtroOwner = async (orgId: string): Promise<void> => {
    const owners = await db.select({ n: sql<number>`count(*)::int` }).from(orgMemberTable)
      .where(and(eq(orgMemberTable.orgId, orgId), eq(orgMemberTable.role, "owner")));
    if ((owners[0]?.n ?? 0) <= 1) {
      throw new OmniError("conflict", "es el único owner: nombra a otro antes de cambiarlo o quitarlo");
    }
  };

  const miembroParam = z.object({ userId: z.string().min(1) });

  app.openapi(
    createRoute({
      method: "patch", path: "/v1/members/{userId}", tags: ["identidad"],
      summary: "Cambiar el rol de alguien en la organización",
      description: "Se aplica en su siguiente petición: el rol se lee en cada una, no se guarda en la sesión.",
      request: {
        params: miembroParam,
        ...body(z.object({ role: z.enum(["owner", "manager", "agent", "viewer"]) })),
      },
      responses: {
        200: json(z.object({ data: z.object({ userId: z.string(), role: z.string() }) }), "cambiado"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("org.members.update"));
      const { userId } = c.req.valid("param");
      const { role } = c.req.valid("json");

      const { role: actual, propio } = await miembroGestionable(principal, userId);
      if (!canGrantRole(propio, role)) {
        throw new OmniError("forbidden", `no puedes otorgar el rol "${role}" teniendo "${propio}"`, {
          tuRol: propio, rolPedido: role,
        });
      }
      if (actual === "owner" && role !== "owner") await exigirOtroOwner(principal.orgId);

      await db.update(orgMemberTable).set({ role })
        .where(and(eq(orgMemberTable.orgId, principal.orgId), eq(orgMemberTable.userId, userId)));
      return c.json({ data: { userId, role } }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete", path: "/v1/members/{userId}", tags: ["identidad"],
      summary: "Quitar a alguien de la organización",
      description:
        "Pierde el acceso al momento: se borran su pertenencia, sus roles por línea en esta " +
        "organización y sus sesiones abiertas en ella. La cuenta no se borra.",
      request: { params: miembroParam },
      responses: {
        200: json(z.object({ data: z.object({ ok: z.boolean() }) }), "quitado"),
        ...errors,
      },
    }),
    async (c) => {
      const principal = c.get("principal");
      await authorize(principal, routeOf("org.members.update"));
      const { userId } = c.req.valid("param");

      const { role } = await miembroGestionable(principal, userId);
      if (role === "owner") await exigirOtroOwner(principal.orgId);

      await db.transaction(async (tx) => {
        await tx.delete(lineMemberTable).where(and(
          eq(lineMemberTable.userId, userId),
          inArray(lineMemberTable.lineId,
            tx.select({ id: lineTable.id }).from(lineTable).where(eq(lineTable.orgId, principal.orgId))),
        ));
        await tx.delete(orgMemberTable)
          .where(and(eq(orgMemberTable.orgId, principal.orgId), eq(orgMemberTable.userId, userId)));
        // Sin esto seguiría dentro hasta que caducara su sesión.
        await tx.delete(sessionTable)
          .where(and(eq(sessionTable.userId, userId), eq(sessionTable.activeOrgId, principal.orgId)));
      });
      return c.json({ data: { ok: true } }, 200);
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
      // Aceptar con contraseña crea una cuenta que entra sin el proveedor; con
      // la contraseña apagada se acepta desde /unirse, entrando con él.
      exigirContrasenaActiva();
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

  // ─────────────────────────────── entrar con OpenID Connect
  /*
   * Fuera del contrato OpenAPI a propósito, como `GET /v1/media/...`: son
   * redirecciones del navegador, no operaciones que una integración llame.
   */
  const cfg = container.config;
  const base = cfg.PUBLIC_URL.replace(/\/$/, "");
  const oidc = cfg.OIDC_ISSUER_URL && cfg.OIDC_CLIENT_ID && cfg.OIDC_CLIENT_SECRET
    ? new OidcClient({
        issuer: cfg.OIDC_ISSUER_URL,
        clientId: cfg.OIDC_CLIENT_ID,
        clientSecret: cfg.OIDC_CLIENT_SECRET,
        redirectUri: `${base}/v1/auth/oidc/callback`,
        displayName: cfg.OIDC_DISPLAY_NAME,
        allowedGroups: cfg.OIDC_ALLOWED_GROUPS.split(",").map((g) => g.trim()).filter(Boolean),
        groupsClaim: cfg.OIDC_GROUPS_CLAIM,
      })
    : null;

  /** Ningún detalle del fallo llega al navegador: se anota aquí y el panel enseña un mensaje genérico. */
  const rechazar = (c: Context<ApiEnv>, motivo: OidcRechazo, detalle: string): Response => {
    console.warn(`entrada OIDC rechazada (${motivo}): ${detalle}`);
    deleteCookie(c, OIDC_COOKIE, { path: OIDC_COOKIE_PATH });
    return c.redirect(`${base}/entrar?error=${motivo}`, 302);
  };

  app.get("/v1/auth/providers", (c) => c.json({
    data: {
      password: cfg.PASSWORD_LOGIN_ENABLED,
      oidc: oidc ? { name: oidc.config.displayName, startUrl: `${base}/v1/auth/oidc/start` } : null,
    },
  }));

  app.get("/v1/auth/oidc/start", async (c) => {
    if (!oidc) throw new OmniError("not_found", "la entrada con OpenID Connect no está configurada");
    // `invitacion`: aceptar una invitación entrando con el proveedor, sin contraseña.
    const invitacion = c.req.query("invitacion");
    const t: EntradaOidc = {
      state: aleatorio(), nonce: aleatorio(), verifier: aleatorio(48),
      next: destinoSeguro(c.req.query("next")),
      ...(invitacion && invitacion.length >= 10 && invitacion.length <= 200 ? { invitacion } : {}),
    };
    let url: string;
    try {
      url = await oidc.authorizeUrl(t);
    } catch (err) {
      return rechazar(c, "sso", (err as Error).message);
    }
    // Lo que hay que comprobar a la vuelta viaja en una cookie corta y solo
    // para esta ruta: sin estado en el servidor, y otro sitio no puede leerla.
    setCookie(c, OIDC_COOKIE, Buffer.from(JSON.stringify(t)).toString("base64url"), {
      httpOnly: true, secure: base.startsWith("https"), sameSite: "Lax",
      path: OIDC_COOKIE_PATH, maxAge: 600,
    });
    return c.redirect(url, 302);
  });

  app.get("/v1/auth/oidc/callback", async (c) => {
    if (!oidc) throw new OmniError("not_found", "la entrada con OpenID Connect no está configurada");
    const t = leerEntradaOidc(getCookie(c, OIDC_COOKIE));
    deleteCookie(c, OIDC_COOKIE, { path: OIDC_COOKIE_PATH });

    const errorProveedor = c.req.query("error");
    if (errorProveedor) return rechazar(c, "sso", `el proveedor devolvió ${errorProveedor}`);
    const state = c.req.query("state");
    const code = c.req.query("code");
    // Sin esta comparación, otro sitio podría colar su propio código y dejar a
    // la víctima dentro de una sesión ajena (CSRF de entrada).
    if (!t || !state || !code || !mismoTexto(state, t.state)) {
      return rechazar(c, "sso", "state ausente o distinto: caducó o empezó en otro navegador");
    }

    try {
      const id = await oidc.exchange(code, t);
      const sesionOidc = { subject: id.subject, sessionId: id.sessionId };
      if (t.invitacion) {
        const orgId = await aceptarInvitacionOidc(t.invitacion, id);
        await crearSesion(c, (await usuarioPorCorreo(id.email))!.id, orgId, sesionOidc);
        return c.redirect(`${base}/`, 302);
      }
      const user = await usuarioPorCorreo(id.email);
      if (!user || user.disabledAt) throw new OidcError("sso-sin-cuenta", `no hay cuenta activa con ${id.email}`);
      const pertenencia = await db.select().from(orgMemberTable)
        .where(eq(orgMemberTable.userId, user.id)).limit(1);
      await crearSesion(c, user.id, pertenencia[0]?.orgId ?? null, sesionOidc);
      return c.redirect(`${base}${destinoSeguro(t.next)}`, 302);
    } catch (err) {
      if (err instanceof OidcError) return rechazar(c, err.motivo, err.message);
      return rechazar(c, "sso", (err as Error).message);
    }
  });

  const usuarioPorCorreo = async (email: string) =>
    (await db.select().from(userTable).where(eq(userTable.email, email)).limit(1))[0];

  /**
   * Acepta una invitación con la identidad del proveedor, en vez de con una
   * contraseña nueva. El correo VERIFICADO del proveedor tiene que ser el de la
   * invitación: si no, quien reciba un enlace reenviado entraría con su propia
   * cuenta en el sitio de otra persona.
   */
  const aceptarInvitacionOidc = async (token: string, id: OidcIdentity): Promise<string> => {
    const inv = (await db.select().from(invitationTable)
      .where(and(eq(invitationTable.tokenHash, await hashToken(token)), isNull(invitationTable.acceptedAt)))
      .limit(1))[0];
    if (!inv || inv.expiresAt.getTime() <= Date.now()) {
      throw new OidcError("sso-invitacion", "la invitación no existe, ya se usó o caducó");
    }
    if (inv.email !== id.email) {
      throw new OidcError("sso-invitacion-correo", `la invitación es para ${inv.email} y el proveedor dice ${id.email}`);
    }
    return db.transaction(async (tx) => {
      // Se reclama primero: dos aceptaciones a la vez no pueden usar el mismo enlace.
      const reclamada = await tx.update(invitationTable).set({ acceptedAt: new Date() })
        .where(and(eq(invitationTable.id, inv.id), isNull(invitationTable.acceptedAt)))
        .returning({ id: invitationTable.id });
      if (reclamada.length === 0) throw new OidcError("sso-invitacion", "la invitación ya se usó");

      const existente = (await tx.select().from(userTable).where(eq(userTable.email, inv.email)).limit(1))[0];
      if (existente?.disabledAt) throw new OidcError("sso-sin-cuenta", `la cuenta ${inv.email} está deshabilitada`);
      const userId = existente?.id ?? `u-${crypto.randomUUID()}`;
      if (!existente) {
        // Sin contraseña: esta cuenta solo entra por el proveedor.
        await tx.insert(userTable).values({ id: userId, email: inv.email, name: id.name, passwordHash: null, emailVerified: true });
      }
      await tx.insert(orgMemberTable).values({ orgId: inv.orgId, userId, role: inv.role }).onConflictDoNothing();
      return inv.orgId;
    });
  };

  /*
   * OpenID Connect Back-Channel Logout 1.0: el proveedor avisa, de servidor a
   * servidor, de que una sesión suya terminó (cierre de sesión, sesión revocada
   * por un administrador, usuario dado de baja). Se cierran las nuestras que
   * nacieron de ella, sin esperar a que caduquen.
   */
  app.post("/v1/auth/oidc/backchannel-logout", async (c) => {
    if (!oidc) throw new OmniError("not_found", "la entrada con OpenID Connect no está configurada");
    c.header("Cache-Control", "no-store");
    const form = await c.req.parseBody();
    const token = form["logout_token"];
    if (typeof token !== "string" || !token) return c.json({ error: "invalid_request" }, 400);
    let cierre: { subject: string | null; sessionId: string | null };
    try {
      cierre = await oidc.verifyLogoutToken(token);
    } catch (err) {
      console.warn(`aviso de cierre de sesión OIDC rechazado: ${(err as Error).message}`);
      return c.json({ error: "invalid_request" }, 400);
    }
    const condicion = cierre.sessionId
      ? eq(sessionTable.oidcSessionId, cierre.sessionId)
      : eq(sessionTable.oidcSubject, cierre.subject!);
    const cerradas = await db.delete(sessionTable).where(condicion).returning({ id: sessionTable.id });
    console.log(`cierre de sesión OIDC: ${cerradas.length} sesión(es) cerrada(s)`);
    return c.body(null, 200);
  });
}

const OIDC_COOKIE = "omni_oidc";
const OIDC_COOKIE_PATH = "/v1/auth/oidc";

interface EntradaOidc { state: string; nonce: string; verifier: string; next: string; invitacion?: string }

function leerEntradaOidc(raw: string | undefined): EntradaOidc | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<EntradaOidc>;
    if (typeof t.state !== "string" || typeof t.nonce !== "string" || typeof t.verifier !== "string") return null;
    return {
      state: t.state, nonce: t.nonce, verifier: t.verifier, next: destinoSeguro(t.next),
      ...(typeof t.invitacion === "string" ? { invitacion: t.invitacion } : {}),
    };
  } catch {
    return null;
  }
}

/** Comparación en tiempo constante. */
function mismoTexto(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
