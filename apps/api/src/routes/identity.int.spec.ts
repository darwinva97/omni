import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabase, migrate, type DbHandle } from "@omni/db";
import { loadConfig } from "../config.js";
import { buildContainer, type Container } from "../container.js";
import { createApp } from "../app.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;

const j = async <T>(r: Response): Promise<T> => (await r.json()) as T;
const cookieDe = (r: Response): string => (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  // Empezar sin ninguna organización: el alta solo funciona así.
  await dbh.sql`TRUNCATE org, app_user, app_session, invitation, org_member, line, api_key CASCADE`;
  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "9".repeat(64),
      SANDBOX_ENABLED: "true",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);
});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

const post = (path: string, cuerpo: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(cuerpo),
  });

run("identidad", () => {
  let cookieDueno = "";

  it("el primero se da de alta y queda como propietario", async () => {
    const res = await post("/v1/auth/register", {
      email: "ada@ejemplo.com", name: "Ada", password: "una contraseña larga",
      orgName: "Mi Empresa",
    });
    expect(res.status).toBe(201);
    cookieDueno = cookieDe(res);
    expect(cookieDueno).toContain("omni_session=");
    // La cookie es httpOnly: el JavaScript del navegador nunca la ve.
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("el segundo NO puede darse de alta: se entra por invitación", async () => {
    // Dejar el registro abierto convierte la instalación en pública.
    const res = await post("/v1/auth/register", {
      email: "intruso@ejemplo.com", name: "X", password: "otra contraseña larga",
      orgName: "Suya",
    });
    expect(res.status).toBe(403);
  });

  it("me dice quién soy y con qué rol", async () => {
    const res = await app.request("/v1/auth/me", { headers: { cookie: cookieDueno } });
    const { data } = await j<{ data: { email: string; role: string } }>(res);
    expect(data.email).toBe("ada@ejemplo.com");
    expect(data.role).toBe("owner");
  });

  it("rechaza la contraseña incorrecta sin distinguir del correo inexistente", async () => {
    const mala = await post("/v1/auth/login", { email: "ada@ejemplo.com", password: "incorrecta" });
    const inexistente = await post("/v1/auth/login", { email: "nadie@ejemplo.com", password: "incorrecta" });
    expect(mala.status).toBe(401);
    expect(inexistente.status).toBe(401);
    // El mismo mensaje en ambos casos: distinguirlos permite enumerar cuentas.
    expect((await j<{ detail: string }>(mala)).detail)
      .toBe((await j<{ detail: string }>(inexistente)).detail);
  });

  it("entra con las credenciales correctas", async () => {
    const res = await post("/v1/auth/login", {
      email: "ada@ejemplo.com", password: "una contraseña larga",
    });
    expect(res.status).toBe(200);
    expect(cookieDe(res)).toContain("omni_session=");
  });

  it("una sesión sirve para operar, igual que una clave", async () => {
    const res = await app.request("/v1/lines", { headers: { cookie: cookieDueno } });
    expect(res.status).toBe(200);
  });

  it("invita, y el invitado entra con su propio rol", async () => {
    const inv = await post("/v1/invitations", { email: "linus@ejemplo.com", role: "agent" }, cookieDueno);
    expect(inv.status).toBe(201);
    const { data } = await j<{ data: { token: string } }>(inv);

    const aceptada = await post("/v1/invitations/accept", {
      token: data.token, name: "Linus", password: "contraseña del invitado",
    });
    expect(aceptada.status).toBe(201);

    const yo = await app.request("/v1/auth/me", { headers: { cookie: cookieDe(aceptada) } });
    expect((await j<{ data: { role: string } }>(yo)).data.role).toBe("agent");
  });

  it("una invitación no se puede usar dos veces", async () => {
    const inv = await post("/v1/invitations", { email: "otro@ejemplo.com", role: "viewer" }, cookieDueno);
    const { data } = await j<{ data: { token: string } }>(inv);
    const primera = await post("/v1/invitations/accept", {
      token: data.token, name: "Otro", password: "contraseña suficientemente larga",
    });
    expect(primera.status).toBe(201);
    const segunda = await post("/v1/invitations/accept", {
      token: data.token, name: "Otro", password: "contraseña suficientemente larga",
    });
    expect(segunda.status).toBe(404);
  });

  it("nadie otorga un rol por encima del suyo", async () => {
    // El agente invitado no puede crear un propietario.
    const inv = await post("/v1/invitations", { email: "agente2@ejemplo.com", role: "agent" }, cookieDueno);
    const { data } = await j<{ data: { token: string } }>(inv);
    const aceptada = await post("/v1/invitations/accept", {
      token: data.token, name: "Agente", password: "contraseña del agente aquí",
    });
    const cookieAgente = cookieDe(aceptada);

    const intento = await post("/v1/invitations", { email: "x@ejemplo.com", role: "owner" }, cookieAgente);
    expect([403]).toContain(intento.status);
  });

  it("el equipo se lista con sus roles", async () => {
    const res = await app.request("/v1/members", { headers: { cookie: cookieDueno } });
    const { data } = await j<{ data: { email: string; role: string }[] }>(res);
    expect(data.find((m) => m.email === "ada@ejemplo.com")?.role).toBe("owner");
    expect(data.find((m) => m.email === "linus@ejemplo.com")?.role).toBe("agent");
  });

  it("cerrar sesión invalida el token, no solo borra la cookie", async () => {
    const entrada = await post("/v1/auth/login", {
      email: "ada@ejemplo.com", password: "una contraseña larga",
    });
    const cookie = cookieDe(entrada);
    expect((await app.request("/v1/auth/me", { headers: { cookie } })).status).toBe(200);

    await post("/v1/auth/logout", {}, cookie);
    // Quien hubiera copiado el token tampoco puede seguir usándolo.
    expect((await app.request("/v1/auth/me", { headers: { cookie } })).status).toBe(401);
  });

  it("una cookie inventada no vale", async () => {
    const res = await app.request("/v1/auth/me", { headers: { cookie: "omni_session=inventado" } });
    expect(res.status).toBe(401);
  });
});
