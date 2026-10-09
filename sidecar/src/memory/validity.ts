import { z } from "zod";
import type { MemoryRecord } from "./index.ts";

/**
 * Whether a memory's claim holds at an instant, and the validity window a tool
 * caller asks for, turned into the timestamps a memory stores.
 */

/** Whether a memory's claim holds at a given instant. */
export type Validity = "current" | "upcoming" | "expired";

export function validityAt(validFrom: Date, validUntil: Date | null, at: Date): Validity {
  if (validFrom.getTime() > at.getTime()) return "upcoming";
  if (validUntil && validUntil.getTime() <= at.getTime()) return "expired";
  return "current";
}

/**
 * What a reader needs to judge whether to trust a memory, beside its content.
 * Shared by the chat tools and the MCP endpoint so both report the same thing.
 */
export function validityFields(record: MemoryRecord) {
  return {
    validity: record.validity,
    validFrom: record.validFrom.toISOString(),
    ...(record.validUntil ? { validUntil: record.validUntil.toISOString() } : {}),
  };
}

/**
 * ISO 8601 durations limited to weeks, days, hours and minutes. Months and
 * years vary in length, so those go through an explicit `validUntil` instead.
 */
const ISO_DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;

const MINUTE_MS = 60_000;

/**
 * The longest window a claim can be given. A claim meant to hold longer should
 * leave the window out, and the cap stops one confirmation from pinning a
 * memory as current for centuries.
 */
const MAX_WINDOW_MS = 10 * 365 * 24 * 60 * MINUTE_MS;

/** Milliseconds in an ISO 8601 duration like `PT1H` or `P1DT12H`, or null if it isn't a usable one. */
export function parseDuration(text: string): number | null {
  const match = ISO_DURATION.exec(text);
  if (!match) return null;
  const [weeks = 0, days = 0, hours = 0, minutes = 0] = match
    .slice(1)
    .map((part) => Number(part ?? 0));
  const ms = (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * MINUTE_MS;
  return ms > 0 && ms <= MAX_WINDOW_MS ? ms : null;
}

/**
 * An ISO 8601 datetime. One without an offset is read in the sidecar's
 * timezone, which is the user's own machine.
 */
export const isoInstant = () => z.iso.datetime({ offset: true, local: true });

/**
 * Tool input fields for a memory's validity window, shared by the chat tools
 * and the MCP endpoint. A raw shape rather than an object so the MCP SDK can
 * take it.
 */
export const validityWindowShape = {
  validFrom: isoInstant()
    .optional()
    .describe(
      "When the claim starts holding, if not now (ISO 8601 datetime; without an offset it is the user's local time) — e.g. the start of a vacation next week, or when a change actually happened",
    ),
  validFor: z
    .string()
    .max(32)
    .regex(ISO_DURATION, "an ISO 8601 duration in weeks, days, hours or minutes, e.g. PT1H")
    .optional()
    .describe(
      "How long the claim can be trusted before it needs re-checking, as an ISO 8601 duration (PT1H, P3D, P2W), measured from validFrom or from now. You aren't told the current time, so use this for anything measured from now, like an outage. Leave out for claims that hold until corrected",
    ),
  validUntil: isoInstant()
    .optional()
    .describe(
      "When the claim ends, if it ends at a known date rather than after a length of time — someone out this week is out until the end of Friday, e.g. 2026-10-16T23:59:59. Without an offset it is the user's local time. Give validFor or validUntil, not both",
    ),
};

export type ValidityWindowRequest = z.infer<z.ZodObject<typeof validityWindowShape>>;

export type ResolvedValidityWindow =
  | { ok: true; validFrom?: Date; validUntil?: Date }
  | { ok: false; error: string };

/**
 * `measuredFrom` is where a window without its own `validFrom` starts: now, or
 * a later start for a memory that hasn't begun to hold yet.
 */
export function resolveValidityWindow(
  request: ValidityWindowRequest,
  measuredFrom: Date,
): ResolvedValidityWindow {
  if (request.validFor && request.validUntil) {
    return { ok: false, error: "give validFor or validUntil, not both" };
  }
  const validFrom = request.validFrom ? new Date(request.validFrom) : undefined;
  const start = validFrom ?? measuredFrom;

  let validUntil: Date | undefined;
  if (request.validFor) {
    const ms = parseDuration(request.validFor);
    if (ms === null) {
      return { ok: false, error: "validFor must be a duration between a minute and ten years" };
    }
    validUntil = new Date(start.getTime() + ms);
  } else if (request.validUntil) {
    validUntil = new Date(request.validUntil);
    const windowMs = validUntil.getTime() - start.getTime();
    if (!(windowMs > 0)) return { ok: false, error: "validUntil must be after the claim starts" };
    if (windowMs > MAX_WINDOW_MS) {
      return { ok: false, error: "validUntil can be at most ten years after the claim starts" };
    }
  }
  return { ok: true, validFrom, validUntil };
}
