import { core } from "./core";

/**
 * Where the server's Postgres URL came from. It is set where the server
 * starts, not in Settings: the server needs it before anyone can sign in.
 */
export type DatabaseSource = "env" | "configFile" | "secretStore" | "default";

export interface DatabaseInfo {
  /** The URL with any password replaced by `****`. */
  url: string;
  source: DatabaseSource;
}

/** The database the server connected to, or null when it can't say (tests). */
export const getDatabaseInfo = () => core<DatabaseInfo | null>("get_database_info");

export const DATABASE_SOURCE_TEXT: Record<DatabaseSource, string> = {
  env: "from the YARVIS_DATABASE_URL environment variable",
  configFile: "from [database] url in server.toml",
  secretStore:
    "from the secret store, where older versions saved it. Move it to YARVIS_DATABASE_URL or [database] url in server.toml",
  default:
    "by default, since neither YARVIS_DATABASE_URL nor [database] url in server.toml names one",
};
