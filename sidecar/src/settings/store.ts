import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Direct sidecar access to `~/.yarvis/settings.json` — the same file the Rust
 * core owns for its own scalar settings (see `src-tauri/src/settings.rs`).
 *
 * The core never reads or writes the keys this module manages (customProviders,
 * providerModels, mcpServers, voiceConfig, embeddingsConfig, wipConfig,
 * githubPrConfig, jobConfig): each is a top-level key in the shared document,
 * touched only by its own section, so a read-modify-write here never clobbers
 * the core's fields (or another section's) even though they live in one file.
 *
 * This is a straight port of the read-modify-write discipline
 * `src-tauri/src/settings.rs` and `src-tauri/src/custom_providers.rs` already
 * use for the Keychain blob: read the whole document, mutate only the one
 * section a caller owns, write the whole document back atomically (temp file +
 * rename).
 */

/** `~/.yarvis/settings.json`, overridable so tests point elsewhere. */
export function settingsPath(): string {
  return process.env.YARVIS_SETTINGS_PATH ?? join(homedir(), ".yarvis", "settings.json");
}

type Document = Record<string, unknown>;

/** A missing or malformed file reads as an empty document, never a thrown error. */
async function readDocument(path: string): Promise<Document> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeDocument(path: string, doc: Document): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * Serializes every write behind one in-process queue. The sidecar is
 * single-threaded, but a read-modify-write straddles an `await`, so two
 * concurrent requests writing different sections could otherwise interleave
 * and one write would clobber the other. This only protects against races
 * within this process — a `dev:instance` sidecar sharing the same file is the
 * same accepted, shrunk-not-eliminated race the Rust core already lives with
 * for its own settings.
 */
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Reads section `key`, hands it to `mutate`, and writes back whatever `mutate`
 * returns as `next` — leaving every other key in the document untouched.
 * Returns `mutate`'s `result`, so a caller can return the value it wants back
 * (e.g. the newly saved row) without a second read.
 */
export function withSection<T, R>(
  key: string,
  mutate: (current: T | undefined) => { next: T; result: R },
): Promise<R> {
  const task = writeQueue.then(async () => {
    const path = settingsPath();
    const doc = await readDocument(path);
    const { next, result } = mutate(doc[key] as T | undefined);
    doc[key] = next;
    await writeDocument(path, doc);
    return result;
  });
  // Chain the next write off this one regardless of outcome, so a failed write
  // doesn't wedge every write queued after it. The caller's own promise still
  // rejects with the real error.
  writeQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/** Point-in-time read of one section, outside the write queue. */
export async function readSection<T>(key: string): Promise<T | undefined> {
  const doc = await readDocument(settingsPath());
  return doc[key] as T | undefined;
}
