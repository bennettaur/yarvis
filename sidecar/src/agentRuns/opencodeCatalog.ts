import { copyFileSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { settingsPath } from "../settings/store.ts";

/**
 * The model catalog OpenCode runs read from a file (`OPENCODE_MODELS_PATH`).
 *
 * An OpenCode process with empty folders of its own knows only the catalog
 * built into its binary until it downloads the live one, and it downloads it
 * in the background: a run that picks its model first fails with "Model
 * unavailable" for any model newer than the build. So Yarvis keeps the
 * catalog itself, refreshed at most once a day, and hands each process a copy.
 */

const CATALOG_URL = "https://models.dev/api.json";

/** How long a downloaded catalog is used before it is fetched again. */
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A catalog is a few MB; anything far past that is not one. */
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 30_000;

/** Beside `settings.json`, outside anything an OpenCode run may write. */
export function catalogPath(): string {
  return join(dirname(settingsPath()), "cache", "opencode-models.json");
}

/** The cached catalog's age, or null when there is none. */
function cachedAgeMs(path: string, now: number): number | null {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** One fetch at a time, shared by every run that starts while it is going. */
let refreshing: Promise<void> | null = null;

async function download(path: string, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`models.dev answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_CATALOG_BYTES) throw new Error("the model catalog is too large");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the model catalog is not a JSON object");
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/**
 * The catalog's path, refreshed first when it is missing or a day old. A
 * failed refresh keeps the old one; with none at all it answers null, and the
 * run falls back to OpenCode's own catalog and download.
 */
export async function openCodeCatalog(
  fetchImpl: typeof fetch = fetch,
  path: string = catalogPath(),
  now: number = Date.now(),
): Promise<string | null> {
  const age = cachedAgeMs(path, now);
  if (age === null || age > CATALOG_MAX_AGE_MS) {
    refreshing ??= download(path, fetchImpl).finally(() => {
      refreshing = null;
    });
    await refreshing.catch((e) =>
      console.error(
        "[agent-runs] could not refresh the OpenCode model catalog:",
        e instanceof Error ? e.message : e,
      ),
    );
  }
  return cachedAgeMs(path, now) === null ? null : path;
}

/**
 * A copy of the catalog inside a process's own folder, since the sandbox keeps
 * the process out of `~/.yarvis`. Null when there is no catalog.
 */
export function copyCatalog(catalog: string | null, folder: string): string | null {
  if (!catalog) return null;
  const copy = join(folder, "models.json");
  try {
    copyFileSync(catalog, copy);
    return copy;
  } catch {
    return null;
  }
}
