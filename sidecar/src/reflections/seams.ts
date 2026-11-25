import type { Db } from "../db/client.ts";

/**
 * What a reflection reads from work that other features record. Each returns
 * nothing until that feature writes something to read, so the reflections
 * run on what exists.
 */

/** What the user did with a verification finding drafted as a review comment. */
export interface DraftOutcome {
  refKey: string;
  path: string | null;
  line: number | null;
  outcome: "accepted" | "edited" | "dropped";
}

/** A root-cause write-up from a revert investigation. */
export interface RootCauseNote {
  title: string;
  text: string;
}

export async function loadDraftOutcomes(
  _db: Db,
  _refKeys: readonly string[],
  _since: Date,
): Promise<DraftOutcome[]> {
  return [];
}

export async function loadRootCauseNotes(_db: Db, _since: Date): Promise<RootCauseNote[]> {
  return [];
}
