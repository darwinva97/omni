import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabase, migrate, orgMemberTable, orgTable, userTable, type DbHandle } from "@omni/db";
import { hashPassword } from "@omni/core";
import { loadConfig } from "./config.js";
import { buildContainer, type Container } from "./container.js";
import { createApp } from "./app.js";
import { MAX_POR_CUENTA } from "./intentos.js";

const URL_DB = process.env["OMNI_TEST_DATABASE_URL"];
const run = URL_DB ? describe : describe.skip;

const ORG = "org-freno";
const CORREO = "freno@ejemplo.test";
const BUENA = "una contraseña larga y distinta";

let dbh: DbHandle;
let container: Container;
let app: ReturnType<typeof createApp>;

const entrar = (password: string, ip = "203.0.113.7", email = CORREO) =>
  app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, password }),
  });

beforeAll(async () => {
  if (!URL_DB) return;
  await migrate(URL_DB);
  dbh = createDatabase(URL_DB);
  await dbh.sql`DELETE FROM omni_kv WHERE key LIKE 'login:fallos:%'`;
  await dbh.sql`DELETE FROM org_member WHERE user_id = 'u-freno'`;
  await dbh.sql`DELETE FROM app_user WHERE email = ${CORREO}`;
  await dbh.sql`DELETE FROM org WHERE id = ${ORG}`;
  await dbh.sql`DELETE FROM org_member WHERE org_id = ${ORG}`;
  await dbh.db.insert(orgTable).values({ id: ORG, name: "Freno", slug: "freno" });

  /*
   * La cuenta se siembra a mano y no por `/v1/auth/register`: ese registro
   * solo funciona mientras no exista NINGUNA organización, a propósito, y en
   * la base de pruebas hay otras de los demás ficheros.
   */
  await dbh.db.insert(userTable).values({
    id: "u-freno", email: CORREO, name: "Freno", emailVerified: true,
    passwordHash: await hashPassword(BUENA),
  });
  await dbh.db.insert(orgMemberTable).values({
    orgId: ORG, userId: "u-freno", role: "owner",
  });

  container = await buildContainer(
    loadConfig({
      ...process.env, DATABASE_URL: URL_DB, OMNI_MASTER_KEY: "b".repeat(64),
      MEDIA_DIR: "./.data/test-media-freno",
    } as NodeJS.ProcessEnv),
    { runMigrations: false, fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch },
  );
  app = createApp(container);

});
afterAll(async () => { await container?.shutdown(); await dbh?.close(); });

run("freno de intentos de inicio de sesión", () => {
  it("tras varios fallos deja de aceptar intentos con esa cuenta", async () => {
    // Sin esto, una contraseña expuesta a internet se adivina a ritmo de red.
    for (let i = 0; i < MAX_POR_CUENTA; i++) {
      const res = await entrar("equivocada");
      expect(res.status).toBe(401);
    }
    const bloqueado = await entrar("equivocada");
    expect(bloqueado.status).toBe(429);

    // Y la contraseña BUENA también se rechaza mientras dure el bloqueo: si
    // no, bastaría con acertar una vez para seguir probando.
    const conLaBuena = await entrar(BUENA);
    expect(conLaBuena.status).toBe(429);
  });

  it("un correo que no existe también gasta intentos", async () => {
    /*
     * Si no contara, se podría recorrer una lista de correos sin gastar nada y
     * averiguar cuáles están dados de alta por la diferencia de trato.
     */
    await dbh.sql`DELETE FROM omni_kv WHERE key LIKE 'login:fallos:%'`;
    const ip = "203.0.113.8";
    for (let i = 0; i < MAX_POR_CUENTA; i++) {
      expect((await entrar("x", ip, "noexiste@ejemplo.test")).status).toBe(401);
    }
    expect((await entrar("x", ip, "noexiste@ejemplo.test")).status).toBe(429);
  });

  it("acertar olvida los fallos de esa cuenta", async () => {
    await dbh.sql`DELETE FROM omni_kv WHERE key LIKE 'login:fallos:%'`;
    const ip = "203.0.113.9";
    for (let i = 0; i < MAX_POR_CUENTA - 1; i++) {
      expect((await entrar("equivocada", ip)).status).toBe(401);
    }
    expect((await entrar(BUENA, ip)).status).toBe(200);

    // El contador de la cuenta se ha olvidado: quedan los intentos enteros.
    for (let i = 0; i < MAX_POR_CUENTA - 1; i++) {
      expect((await entrar("equivocada", ip)).status).toBe(401);
    }
  });

  it("el bloqueo por origen atrapa el recorrido de muchas cuentas", async () => {
    /*
     * El contador por cuenta no ve este ataque: una contraseña, mil correos,
     * un fallo por cuenta. El del origen sí.
     */
    await dbh.sql`DELETE FROM omni_kv WHERE key LIKE 'login:fallos:%'`;
    const ip = "198.51.100.4";
    let bloqueos = 0;
    for (let i = 0; i < 40; i++) {
      const res = await entrar("la-de-siempre", ip, `victima${i}@ejemplo.test`);
      if (res.status === 429) bloqueos++;
    }
    expect(bloqueos).toBeGreaterThan(0);
  });

  it("el freno es del servicio, no del proceso", async () => {
    /*
     * Vive en el KV respaldado por Postgres. Si fuera memoria del proceso,
     * repartir la API entre tres nodos triplicaría los intentos permitidos.
     */
    await dbh.sql`DELETE FROM omni_kv WHERE key LIKE 'login:fallos:%'`;
    await entrar("equivocada", "203.0.113.20");
    const filas = await dbh.sql`SELECT key FROM omni_kv WHERE key LIKE 'login:fallos:%'`;
    expect(filas.length).toBeGreaterThan(0);
  });
});
