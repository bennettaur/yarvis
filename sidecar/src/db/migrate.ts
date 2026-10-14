import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loadConfig } from "../config.ts";

/**
 * A packaged sidecar is a single compiled binary with no checkout around it, so
 * the app points `YARVIS_MIGRATIONS_DIR` at the copy it bundles as a resource.
 */
function migrationsFolder(): string {
  return process.env.YARVIS_MIGRATIONS_DIR || `${import.meta.dir}/../../drizzle`;
}

/**
 * Applies pending Drizzle migrations. Run on sidecar startup (and via
 * `bun run db:migrate`). Enables the pgvector extension first so future
 * embedding-backed features have it available.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: migrationsFolder() });
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  const config = loadConfig();
  if (!config.databaseUrl) {
    console.error("[migrate] DATABASE_URL is not set");
    process.exit(1);
  }
  await runMigrations(config.databaseUrl);
}
