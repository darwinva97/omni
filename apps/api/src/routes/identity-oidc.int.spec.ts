import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDatabase, migrate, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";

/*
 * Instalación SOLO con proveedor OIDC (PASSWORD_LOGIN_ENABLED=false), contra un
 * proveedor de mentira que firma de verdad: alta por invitación, gestión del
 * equipo y cierre de sesión por canal trasero.
 */

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;
const PUBLIC = "http://omni.test";
const CLIENT = "omni";

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;
let idp: Server;
let issuer = "";
let privada: CryptoKey;

/** Lo que el proveedor de mentira pondrá en el próximo id_token, por código. */
const porCodigo = new Map<string, Record<string, unknown>>();
let nonceVisto = "";
/** Estado de cada cuenta en el proveedor, para la renovación (refresh_token = "rt:<correo>"). */
const enProveedor = new Map<string, { claims: Record<string, unknown>; estado: "ok" | "desactivada" | "caido" }>();

const firmar = (claims: Record<string, unknown>) =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer)
    .setAudience(CLIENT).setIssuedAt().setExpirationTime("5m").sign(privada);

const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;
const cookieDe = (r: Response, nombre: string): string =>
  (r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie") ?? ""])
    .map((c) => c.split(";")[0] ?? "").find((c) => c.startsWith(`${nombre}=`)) ?? "";

beforeAll(async () => {
  if (!URL_DB) return;
  const par = await generateKeyPair("RS256");
  privada = par.privateKey;
  const jwk = { ...(await exportJWK(par.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

  idp = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const send = (o: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return send({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/certs` });
    }
    if (url.pathname.endsWith("/certs")) return send({ keys: [jwk] });
    if (url.pathname.endsWith("/token")) {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", async () => {
        const p = new URLSearchParams(body);
        if (p.get("grant_type") === "refresh_token") {
          const cuenta = enProveedor.get((p.get("refresh_token") ?? "").replace(/^rt:/, ""));
          if (cuenta?.estado === "caido") { res.statusCode = 503; return send({ error: "temporarily_unavailable" }); }
          // Así responde Keycloak a una cuenta desactivada o a una sesión cerrada.
          if (!cuenta || cuenta.estado === "desactivada") { res.statusCode = 400; return send({ error: "invalid_grant" }); }
          return send({ id_token: await firmar(cuenta.claims), refresh_token: p.get("refresh_token") });
        }
        const claims = porCodigo.get(p.get("code") ?? "");
        if (!claims) { res.statusCode = 400; return send({ error: "invalid_grant" }); }
        enProveedor.set(String(claims["email"]), { claims, estado: "ok" });
        send({ id_token: await firmar({ ...claims, nonce: nonceVisto }), refresh_token: `rt:${String(claims["email"])}` });
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((ok) => idp.listen(0, "127.0.0.1", () => ok()));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/realms/r`;

  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  await dbh.sql`TRUNCATE org, app_user, app_session, invitation, org_member, line, api_key CASCADE`;
  // Sin contraseña no hay alta por /register: la organización y su dueño nacen aquí.
  await dbh.sql`INSERT INTO org (id, name, slug) VALUES ('o-1', 'Bezenti', 'bezenti')`;
  await dbh.sql`INSERT INTO app_user (id, email, name, email_verified) VALUES ('u-dueno', 'dueno@ejemplo.com', 'Dueño', true)`;
  await dbh.sql`INSERT INTO org_member (org_id, user_id, role) VALUES ('o-1', 'u-dueno', 'owner')`;

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "9".repeat(64), PUBLIC_URL: PUBLIC,
      PASSWORD_LOGIN_ENABLED: "false", OIDC_ISSUER_URL: issuer, OIDC_CLIENT_ID: CLIENT,
      OIDC_CLIENT_SECRET: "secreto", OIDC_ALLOWED_GROUPS: "devs,admins", OIDC_SESSION_HOURS: "12",
    } as NodeJS.ProcessEnv),
    { runMigrations: false },
  );
  app = createApp(container);
});
afterAll(async () => {
  await container?.shutdown(); await dbh?.close();
  await new Promise<void>((ok) => (idp ? idp.close(() => ok()) : ok()));
});

/** Una vuelta completa por el navegador. Devuelve a dónde termina y la cookie de sesión. */
async function entrar(email: string, opts: { sid?: string; groups?: string[]; invitacion?: string } = {}) {
  const inicio = await app.request(`/v1/auth/oidc/start${opts.invitacion ? `?invitacion=${opts.invitacion}` : ""}`);
  const auth = new URL(inicio.headers.get("location") ?? "");
  nonceVisto = auth.searchParams.get("nonce") ?? "";
  const code = `c-${Math.random()}`;
  porCodigo.set(code, {
    sub: `sub-${email}`, email, email_verified: true, name: email.split("@")[0],
    groups: opts.groups ?? ["devs"], ...(opts.sid ? { sid: opts.sid } : {}),
  });
  const vuelta = await app.request(`/v1/auth/oidc/callback?code=${code}&state=${auth.searchParams.get("state")}`, {
    headers: { cookie: cookieDe(inicio, "omni_oidc") },
  });
  return { location: vuelta.headers.get("location") ?? "", cookie: cookieDe(vuelta, "omni_session") };
}

const me = (cookie: string) => app.request("/v1/auth/me", { headers: { cookie } });
const llamar = (method: string, path: string, cookie: string, cuerpo?: unknown) =>
  app.request(path, {
    method, headers: { cookie, ...(cuerpo ? { "content-type": "application/json" } : {}) },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });

run("instalación solo con proveedor OIDC", () => {
  let dueno = "";

  it("la contraseña está cerrada: ni entrar, ni darse de alta, ni aceptar invitaciones", async () => {
    const json = { "content-type": "application/json" };
    const login = await app.request("/v1/auth/login", { method: "POST", headers: json, body: JSON.stringify({ email: "dueno@ejemplo.com", password: "x".repeat(12) }) });
    const alta = await app.request("/v1/auth/register", { method: "POST", headers: json, body: JSON.stringify({ email: "a@b.com", name: "A", password: "x".repeat(12), orgName: "O" }) });
    const aceptar = await app.request("/v1/invitations/accept", { method: "POST", headers: json, body: JSON.stringify({ token: "t".repeat(20), name: "A", password: "x".repeat(12) }) });
    expect([login.status, alta.status, aceptar.status]).toEqual([403, 403, 403]);
    const { data } = await j<{ data: { password: boolean } }>(await app.request("/v1/auth/providers"));
    expect(data.password).toBe(false);
  });

  it("el dueño entra con el proveedor, en una sesión de 12 horas y no de 30 días", async () => {
    const r = await entrar("dueno@ejemplo.com", { groups: ["admins"], sid: "kc-dueno" });
    expect(r.location).toBe(`${PUBLIC}/`);
    dueno = r.cookie;
    expect((await j<{ data: { role: string } }>(await me(dueno))).data.role).toBe("owner");
    const [fila] = await dbh.sql<{ horas: number; sid: string }[]>`
      SELECT extract(epoch FROM expires_at - created_at) / 3600 AS horas, oidc_session_id AS sid
      FROM app_session WHERE user_id = 'u-dueno'`;
    expect(Math.round(Number(fila!.horas))).toBe(12);
    expect(fila!.sid).toBe("kc-dueno");
  });

  it("una invitación se acepta entrando con el proveedor, con el rol elegido y sin contraseña", async () => {
    const inv = await j<{ data: { token: string } }>(await llamar("POST", "/v1/invitations", dueno, { email: "bea@ejemplo.com", role: "agent" }));
    const r = await entrar("bea@ejemplo.com", { invitacion: inv.data.token, sid: "kc-bea" });
    expect(r.location).toBe(`${PUBLIC}/`);
    expect((await j<{ data: { role: string } }>(await me(r.cookie))).data.role).toBe("agent");
    const [u] = await dbh.sql<{ hash: string | null }[]>`SELECT password_hash AS hash FROM app_user WHERE email = 'bea@ejemplo.com'`;
    expect(u!.hash).toBeNull();
    // El enlace es de un solo uso.
    expect((await entrar("bea@ejemplo.com", { invitacion: inv.data.token })).location).toContain("error=sso-invitacion");
  });

  it("una invitación reenviada no sirve con otra cuenta del proveedor", async () => {
    const inv = await j<{ data: { token: string } }>(await llamar("POST", "/v1/invitations", dueno, { email: "carla@ejemplo.com", role: "viewer" }));
    expect((await entrar("otra@ejemplo.com", { invitacion: inv.data.token })).location).toContain("error=sso-invitacion-correo");
    // Y sigue disponible para su destinataria.
    expect((await entrar("carla@ejemplo.com", { invitacion: inv.data.token })).location).toBe(`${PUBLIC}/`);
  });

  it("sin cuenta en Omni no se entra, aunque el proveedor lo conozca", async () => {
    expect((await entrar("desconocido@ejemplo.com")).location).toContain("error=sso-sin-cuenta");
  });

  it("cambiar el rol se aplica en la siguiente petición", async () => {
    const bea = await entrar("bea@ejemplo.com");
    const ids = await j<{ data: { userId: string; email: string }[] }>(await llamar("GET", "/v1/members", dueno));
    const beaId = ids.data.find((m) => m.email === "bea@ejemplo.com")!.userId;
    expect((await llamar("PATCH", `/v1/members/${beaId}`, dueno, { role: "manager" })).status).toBe(200);
    expect((await j<{ data: { role: string } }>(await me(bea.cookie))).data.role).toBe("manager");
  });

  it("nadie gestiona a quien está por encima, ni otorga más de lo que tiene", async () => {
    const bea = await entrar("bea@ejemplo.com"); // manager desde la prueba anterior
    expect((await llamar("PATCH", "/v1/members/u-dueno", bea.cookie, { role: "viewer" })).status).toBe(403);
  });

  it("la organización nunca se queda sin owner", async () => {
    expect((await llamar("PATCH", "/v1/members/u-dueno", dueno, { role: "manager" })).status).toBe(409);
    expect((await llamar("DELETE", "/v1/members/u-dueno", dueno)).status).toBe(409);
  });

  it("quitar a alguien le cierra la sesión al momento, y no puede volver a entrar", async () => {
    const carla = await entrar("carla@ejemplo.com");
    expect((await me(carla.cookie)).status).toBe(200);
    const ids = await j<{ data: { userId: string; email: string }[] }>(await llamar("GET", "/v1/members", dueno));
    const carlaId = ids.data.find((m) => m.email === "carla@ejemplo.com")!.userId;
    expect((await llamar("DELETE", `/v1/members/${carlaId}`, dueno)).status).toBe(200);
    expect((await me(carla.cookie)).status).toBe(401);
    // Conserva la cuenta, pero sin organización no entra.
    expect((await entrar("carla@ejemplo.com")).location).toContain("error=sso-sin-cuenta");
  });

  describe("revalidación con el proveedor", () => {
    /** Hace que la próxima petición tenga que revalidar, sin esperar los minutos de verdad. */
    const envejecer = (email: string) => dbh.sql`
      UPDATE app_session SET oidc_checked_at = now() - interval '1 hour'
      WHERE user_id = (SELECT id FROM app_user WHERE email = ${email})`;

    it("la renovación se guarda sellada, no en claro", async () => {
      await entrar("bea@ejemplo.com");
      const [f] = await dbh.sql<{ rt: string }[]>`
        SELECT oidc_refresh_token AS rt FROM app_session s JOIN app_user u ON u.id = s.user_id
        WHERE u.email = 'bea@ejemplo.com' ORDER BY s.created_at DESC LIMIT 1`;
      expect(f!.rt).toMatch(/^v1\./);
      expect(f!.rt).not.toContain("bea@ejemplo.com");
    });

    it("desactivar a alguien en el proveedor lo saca en la siguiente revalidación", async () => {
      // Keycloak no cierra sus sesiones al desactivar: no hay aviso que esperar.
      const bea = await entrar("bea@ejemplo.com");
      expect((await me(bea.cookie)).status).toBe(200);
      enProveedor.get("bea@ejemplo.com")!.estado = "desactivada";
      expect((await me(bea.cookie)).status).toBe(200); // aún dentro del margen
      await envejecer("bea@ejemplo.com");
      expect((await me(bea.cookie)).status).toBe(401);
      enProveedor.get("bea@ejemplo.com")!.estado = "ok";
    });

    it("sacarlo de los grupos con acceso también lo saca", async () => {
      const bea = await entrar("bea@ejemplo.com");
      enProveedor.get("bea@ejemplo.com")!.claims = { ...enProveedor.get("bea@ejemplo.com")!.claims, groups: ["ventas"] };
      await envejecer("bea@ejemplo.com");
      expect((await me(bea.cookie)).status).toBe(401);
      enProveedor.get("bea@ejemplo.com")!.claims = { ...enProveedor.get("bea@ejemplo.com")!.claims, groups: ["devs"] };
    });

    it("si el proveedor está caído no se echa a nadie", async () => {
      const bea = await entrar("bea@ejemplo.com");
      enProveedor.get("bea@ejemplo.com")!.estado = "caido";
      await envejecer("bea@ejemplo.com");
      expect((await me(bea.cookie)).status).toBe(200);
      enProveedor.get("bea@ejemplo.com")!.estado = "ok";
      await envejecer("bea@ejemplo.com");
      expect((await me(bea.cookie)).status).toBe(200);
    });

    it("las sesiones de contraseña no se tocan", async () => {
      const [n] = await dbh.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM app_session WHERE oidc_refresh_token IS NULL AND oidc_subject IS NOT NULL`;
      expect(n!.n).toBe(0);
    });
  });

  it("el aviso de cierre del proveedor cierra las sesiones de esa sesión suya, y no otras", async () => {
    const bea = await entrar("bea@ejemplo.com", { sid: "kc-bea-2" });
    const aviso = await firmar({ sub: "sub-bea@ejemplo.com", sid: "kc-bea-2", jti: "j-1",
      events: { "http://schemas.openid.net/event/backchannel-logout": {} } });
    const res = await app.request("/v1/auth/oidc/backchannel-logout", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ logout_token: aviso }).toString(),
    });
    expect(res.status).toBe(200);
    expect((await me(bea.cookie)).status).toBe(401);
    expect((await me(dueno)).status).toBe(200);
  });

  it("un aviso de cierre falso o un id_token no cierran nada", async () => {
    const bea = await entrar("bea@ejemplo.com", { sid: "kc-bea-3" });
    const idToken = await firmar({ sub: "sub-bea@ejemplo.com", sid: "kc-bea-3", nonce: "n" });
    const res = await app.request("/v1/auth/oidc/backchannel-logout", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ logout_token: idToken }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await me(bea.cookie)).status).toBe(200);
  });
});
