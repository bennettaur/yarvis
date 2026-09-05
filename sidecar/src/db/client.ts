import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Db = PostgresJsDatabase<typeof schema>;

interface DbHandle {
  db: Db;
  sql: postgres.Sql;
}

const handles = new Map<string, DbHandle>();

/**
 * Returns a lazily-created Drizzle client bound to the given connection string.
 * The first call for a given URL establishes its pool; later calls with that
 * same URL reuse it. Keyed by URL (rather than a single cached instance) so a
 * test process that touches more than one connection string — a real test
 * database alongside a throwaway placeholder used only to satisfy a guard
 * check — can't have the placeholder's pool leak into every other caller.
 */
export function getDb(databaseUrl: string): DbHandle {
  let handle = handles.get(databaseUrl);
  if (!handle) {
    const sql = postgres(databaseUrl, { max: 5, connect_timeout: 5 });
    handle = { db: drizzle(sql, { schema }), sql };
    handles.set(databaseUrl, handle);
  }
  return handle;
}

const PING_TIMEOUT_MS = 3000;

/** Lightweight reachability check used by the health UI; never throws. */
export async function pingDb(databaseUrl: string): Promise<boolean> {
  try {
    const { sql } = getDb(databaseUrl);
    const ping = sql`select 1`;
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("db ping timeout")), PING_TIMEOUT_MS),
    );
    await Promise.race([ping, timeout]);
    return true;
  } catch {
    return false;
  }
}
