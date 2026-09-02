/**
 * A failure as the UI shows it: one readable line, plus the full diagnosis the
 * user can expand and copy. `detail` is absent when there is nothing more to
 * say than the line itself.
 */
export interface DisplayError {
  message: string;
  detail?: string;
}

/** Cap on a serialized value, so one huge object can't fill the detail view. */
const SERIALIZED_CHARS = 4000;

/**
 * JSON for a thrown value that isn't an `Error`. Own non-enumerable properties
 * are included and cycles broken, because the alternative — `String(value)` —
 * is the `[object Object]` that makes a failure unreadable.
 */
function serialize(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const seen = new WeakSet<object>();
  const expand = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return "[circular]";
    seen.add(input);
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(input)) {
      // The stack is noise beside the fields; the sidecar skips it too.
      if (key === "stack") continue;
      out[key] = expand(input[key as never]);
    }
    return out;
  };
  let json = "";
  try {
    json = JSON.stringify(expand(value), null, 2) ?? "";
  } catch {
    json = "";
  }
  if (!json || json === "{}") return `<${value.constructor?.name ?? "object"} with no fields>`;
  return json.length > SERIALIZED_CHARS ? `${json.slice(0, SERIALIZED_CHARS)}…` : json;
}

/**
 * Turns anything caught in a `catch` into something worth showing. Errors thrown
 * across the Tauri boundary and by provider SDKs are routinely plain objects
 * rather than `Error`s, so the message fields are unwrapped before falling back
 * to a readable serialization — never `String(value)`, which yields
 * `[object Object]` and tells the user nothing.
 */
export function formatError(error: unknown): DisplayError {
  if (error instanceof Error) {
    const detail = (error as { detail?: unknown }).detail;
    return {
      message: error.message || error.name || "Unknown error",
      detail: typeof detail === "string" && detail ? detail : (error.stack ?? undefined),
    };
  }
  if (typeof error === "string") return { message: error };
  if (error === null || error === undefined || typeof error !== "object") {
    return { message: String(error) };
  }
  const rec = error as Record<string, unknown>;
  const nested = rec.error;
  const message =
    (typeof rec.message === "string" && rec.message) ||
    (typeof nested === "string" && nested) ||
    (nested &&
    typeof nested === "object" &&
    typeof (nested as Record<string, unknown>).message === "string"
      ? ((nested as Record<string, unknown>).message as string)
      : "") ||
    (typeof rec.detail === "string" && rec.detail) ||
    "Unknown error";
  return { message, detail: serialize(error) };
}

/** The message and its detail as one block, for the clipboard and bug reports. */
export function errorText(error: DisplayError): string {
  return error.detail ? `${error.message}\n\n${error.detail}` : error.message;
}
