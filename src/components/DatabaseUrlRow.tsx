import { useEffect, useState } from "react";
import { DATABASE_SOURCE_TEXT, type DatabaseInfo, getDatabaseInfo } from "../lib/database";

/**
 * The database URL the server uses, read-only. Changing it means changing
 * where the server starts (its environment or `server.toml`) and restarting
 * it, since the server needs the database before anyone can sign in.
 */
export default function DatabaseUrlRow() {
  const [info, setInfo] = useState<DatabaseInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getDatabaseInfo()
      .then((value) => active && setInfo(value))
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      active = false;
    };
  }, []);

  return (
    <div>
      <div className="mb-1 text-sm font-medium">Database URL</div>
      {info ? (
        <>
          <code className="block break-all rounded-md bg-zinc-950 px-2 py-1.5 text-xs text-zinc-300">
            {info.url}
          </code>
          <p className="mt-1 text-xs text-zinc-500">
            Set {DATABASE_SOURCE_TEXT[info.source]}. To change it, change it there and restart the
            server.
          </p>
        </>
      ) : (
        <p className="text-xs text-zinc-500">
          {error ?? "The server didn't say which database it uses."}
        </p>
      )}
    </div>
  );
}
