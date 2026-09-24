import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema/index.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  readonly db: Database;
  readonly sql: Sql;
  close(): Promise<void>;
}

export function createDatabase(url: string, opts: { max?: number } = {}): DbHandle {
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql, close: async () => { await sql.end({ timeout: 5 }); } };
}

export { schema };
