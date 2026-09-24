import postgres, { type Sql } from "postgres";

/**
 * Conexión de pruebas. Si no hay `OMNI_TEST_DATABASE_URL`, las pruebas de
 * integración se saltan en vez de fallar: un colaborador sin Postgres puede
 * seguir corriendo las unitarias.
 */
export const TEST_DATABASE_URL = process.env["OMNI_TEST_DATABASE_URL"] ?? null;
export const hasTestDatabase = TEST_DATABASE_URL !== null;

export function testSql(): Sql {
  if (!TEST_DATABASE_URL) throw new Error("falta OMNI_TEST_DATABASE_URL");
  return postgres(TEST_DATABASE_URL, { max: 10, onnotice: () => {} });
}

/** Deja las tablas de plataforma vacías entre ficheros de prueba. */
export async function truncatePlatform(sql: Sql): Promise<void> {
  await sql`TRUNCATE omni_job, omni_kv`.catch(() => {});
}
