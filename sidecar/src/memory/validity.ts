import { z } from "zod";

/**
 * Turns the validity a tool caller asks for into the timestamps a memory
 * stores. Callers say how long a claim holds (`validFor`) rather than when it
 * stops, because the chat model is only told today's date, not the time — so
 * "an hour from now" is only computable here.
 */

/**
 * ISO 8601 durations limited to weeks, days, hours and minutes. Months and
 * years vary in length, so those go through an explicit `validUntil` instead.
 */
const DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;

const MINUTE_MS = 60_000;

/** Milliseconds in an ISO 8601 duration like `PT1H` or `P1DT12H`, or null if it isn't one. */
export function parseDuration(text: string): number | null {
  const match = DURATION.exec(text);
  if (!match || match.slice(1).every((part) => part === undefined)) return null;
  const [weeks = 0, days = 0, hours = 0, minutes = 0] = match
    .slice(1)
    .map((part) => Number(part ?? 0));
  const ms = (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * MINUTE_MS;
  return ms > 0 ? ms : null;
}

const instant = () => z.iso.datetime({ offset: true, local: true });

/**
 * Tool input fields for a memory's validity, shared by the chat tools and the
 * MCP endpoint. A raw shape rather than an object so the MCP SDK can take it.
 */
export const validityShape = {
  validFrom: instant()
    .optional()
    .describe(
      "When the claim starts holding, if not now (ISO 8601 datetime) — e.g. the start of a vacation next week, or when a change happened",
    ),
  validFor: z
    .string()
    .regex(DURATION, "an ISO 8601 duration in weeks, days, hours or minutes, e.g. PT1H")
    .optional()
    .describe(
      "How long the claim can be trusted before it needs re-checking, as an ISO 8601 duration: PT1H, P3D, P2W. Measured from validFrom, or from now. Leave out for claims that hold until corrected",
    ),
  validUntil: instant()
    .optional()
    .describe("An exact end instead of validFor (ISO 8601 datetime); use one or the other"),
};

export interface ValidityRequest {
  validFrom?: string;
  validFor?: string;
  validUntil?: string;
}

export type ResolvedValidity =
  | { ok: true; validFrom?: Date; validUntil?: Date }
  | { ok: false; error: string };

export function resolveValidity(request: ValidityRequest, now: Date): ResolvedValidity {
  if (request.validFor && request.validUntil) {
    return { ok: false, error: "give validFor or validUntil, not both" };
  }
  const validFrom = request.validFrom ? new Date(request.validFrom) : undefined;
  const start = validFrom ?? now;

  let validUntil: Date | undefined;
  if (request.validFor) {
    const ms = parseDuration(request.validFor);
    if (ms === null) return { ok: false, error: `not a usable duration: ${request.validFor}` };
    validUntil = new Date(start.getTime() + ms);
  } else if (request.validUntil) {
    validUntil = new Date(request.validUntil);
    if (validUntil.getTime() <= start.getTime()) {
      return { ok: false, error: "validUntil must be after validFrom (or now)" };
    }
  }
  return { ok: true, validFrom, validUntil };
}
