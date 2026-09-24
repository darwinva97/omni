import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";

/**
 * Runner de migraciones propio: ficheros `.sql` numerados, aplicados en orden,
 * cada uno en su transacción y anotado en `omni_migration`.
 *
 * Es propio y no el de drizzle-kit porque el esquema necesita SQL que un
 * generador no produce —`message` nace PARTICIONADA— y porque el mismo runner
 * tiene que poder ejecutarse dentro de la imagen de producción, sin dev deps.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

export const PARTITION_DDL = "SELECT omni_ensure_message_partitions($1, $2)";

async function ensureLedger(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS omni_migration (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
}

export async function migrate(url: string, opts: { dir?: string; log?: (m: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    await ensureLedger(sql);
    const done = new Set(
      (await sql<{ name: string }[]>`SELECT name FROM omni_migration`).map((r) => r.name),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(join(dir, file), "utf8");
      // drizzle-kit separa sentencias con este marcador; fuera de él, el fichero
      // es SQL normal y puede contener funciones con `;` dentro.
      const statements = body.includes("--> statement-breakpoint")
        ? body.split("--> statement-breakpoint")
        : [body];
      await sql.begin(async (tx) => {
        for (const stmt of statements) {
          const trimmed = stmt.trim();
          if (trimmed.length > 0) await tx.unsafe(trimmed);
        }
        await tx`INSERT INTO omni_migration (name) VALUES (${file})`;
      });
      applied.push(file);
      log(`aplicada ${file}`);
    }
    return applied;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Asegura que existan las particiones de la ventana pedida. Idempotente. */
export async function ensurePartitions(sql: Sql, back = 1, ahead = 3): Promise<void> {
  await sql.unsafe(PARTITION_DDL, [back, ahead]);
}

// Permite `node dist/migrate.js` dentro de la imagen, sin dependencias de desarrollo.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/)/, ""))) {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("falta DATABASE_URL");
    process.exit(1);
  }
  const applied = await migrate(url, { log: (m) => console.log(m) });
  console.log(applied.length === 0 ? "sin migraciones pendientes" : `${applied.length} migraciones aplicadas`);
}
