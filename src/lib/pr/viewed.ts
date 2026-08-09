import { useCallback, useEffect, useRef, useState } from "react";
import { ensureOk, sidecarFetch } from "../api";
import { refApiPath, refKey } from "./ref";
import type { PrRef } from "./types";

/**
 * Per-file "viewed" state for the in-app PR review. GitHub stores this natively
 * (the same flag the github.com UI exposes), so a check there syncs back to
 * github.com. Azure DevOps has no equivalent, so for Azure we persist to
 * localStorage on this machine — explicit local tracking, not synced.
 */

const AZURE_STORAGE_PREFIX = "yarvis.prViewed:";

function azureKey(ref: PrRef): string {
  // refKey already encodes provider + identity uniquely, so a single prefix is
  // enough to namespace across all PRs.
  return AZURE_STORAGE_PREFIX + refKey(ref);
}

function readAzureViewed(ref: PrRef): Set<string> {
  try {
    const raw = localStorage.getItem(azureKey(ref));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    // Storage might be corrupted or quota-exhausted; fall back to empty so the
    // UI keeps working and the next write rewrites the slot.
    return new Set();
  }
}

function writeAzureViewed(ref: PrRef, viewed: Set<string>): void {
  try {
    localStorage.setItem(azureKey(ref), JSON.stringify([...viewed]));
  } catch {
    // Best-effort — if storage is full or unavailable, the in-memory set still
    // reflects the user's clicks for the rest of the session.
  }
}

/** Fetches the set of viewed file paths for a PR. */
export async function listViewed(ref: PrRef): Promise<Set<string>> {
  if (ref.provider === "azure") return readAzureViewed(ref);
  const res = await sidecarFetch(`${refApiPath(ref)}/viewed`);
  await ensureOk(res, "list viewed");
  const paths: string[] = await res.json();
  return new Set(paths);
}

/** Marks (or unmarks) one file as viewed, syncing to the provider when supported. */
export async function setViewed(ref: PrRef, path: string, viewed: boolean): Promise<void> {
  if (ref.provider === "azure") {
    const current = readAzureViewed(ref);
    if (viewed) current.add(path);
    else current.delete(path);
    writeAzureViewed(ref, current);
    return;
  }
  const res = await sidecarFetch(`${refApiPath(ref)}/viewed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, viewed }),
  });
  await ensureOk(res, "set viewed");
}

/**
 * Marks several files viewed at once, returning the ones that could not be
 * saved. Written one at a time rather than in parallel: GitHub takes a mutation
 * per file, and a guide step can cover every test file in the change.
 */
export async function markManyViewed(ref: PrRef, paths: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const path of paths) {
    try {
      await setViewed(ref, path, true);
    } catch (e) {
      // Logged rather than only counted: a revoked token and a path the
      // provider rejected both surface to the user as the same tally, and
      // without this there is nothing to tell them apart by.
      console.error(`[pr] could not mark ${path} viewed:`, e);
      failed.push(path);
    }
  }
  return failed;
}

/**
 * Component-friendly hook over the viewed set. Loads on mount / ref change,
 * exposes a `toggle` that updates locally first (so the checkbox feels instant)
 * and reconciles with the provider in the background. On failure the optimistic
 * update is rolled back and the error is returned via `error`.
 */
export function usePrViewedFiles(ref: PrRef | null): {
  viewed: Set<string>;
  loading: boolean;
  error: string | null;
  toggle: (path: string) => Promise<void>;
  /** Marks files viewed without unmarking any already marked. */
  markAllViewed: (paths: string[]) => Promise<void>;
} {
  const [viewed, setLocal] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<boolean>(ref !== null);
  const [error, setError] = useState<string | null>(null);

  // What is on screen, readable outside a render. `markAllViewed` needs to know
  // what it is about to write before React gets round to rendering it.
  const mirror = useRef(viewed);
  mirror.current = viewed;

  const apply = useCallback((next: Set<string>) => {
    mirror.current = next;
    setLocal(next);
  }, []);

  // Re-run on refKey so parents that rebuild an equivalent ref object each
  // render don't re-trigger the fetch.
  const key = ref ? refKey(ref) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on refKey, not ref identity
  useEffect(() => {
    if (!ref) {
      apply(new Set());
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    listViewed(ref)
      .then((set) => {
        if (!live) return;
        apply(set);
        setLoading(false);
      })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [key]);

  const toggle = useCallback(
    async (path: string) => {
      if (!ref) return;
      // Flip against the mirror rather than a captured `viewed` closure, so
      // rapid double-clicks always move relative to what is actually on screen,
      // and the rollback below moves in the opposite direction even after
      // another toggle interleaves.
      const nextViewed = !mirror.current.has(path);
      const next = new Set(mirror.current);
      if (nextViewed) next.add(path);
      else next.delete(path);
      apply(next);
      try {
        await setViewed(ref, path, nextViewed);
      } catch (e) {
        const rolledBack = new Set(mirror.current);
        if (nextViewed) rolledBack.delete(path);
        else rolledBack.add(path);
        apply(rolledBack);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [ref, apply],
  );

  // Advancing a guided-review step marks the files that step covered, which is
  // a "mark these done" and never an unmark: a file already ticked stays ticked
  // and is not written again.
  //
  // The delta is computed from a mirror of the set rather than from inside a
  // state updater. React runs an updater when it renders, not when it is
  // queued, so a write that read its own delta out of one would find nothing to
  // write and persist nothing at all — the marks would live until a reload.
  const markAllViewed = useCallback(
    async (paths: string[]) => {
      if (!ref) return;
      const added = paths.filter((p) => !mirror.current.has(p));
      if (added.length === 0) return;
      const optimistic = new Set(mirror.current);
      for (const p of added) optimistic.add(p);
      apply(optimistic);

      const failed = await markManyViewed(ref, added);
      if (failed.length === 0) return;
      const rolledBack = new Set(mirror.current);
      for (const p of failed) rolledBack.delete(p);
      apply(rolledBack);
      setError(`Could not mark ${failed.length} file(s) viewed`);
    },
    [ref, apply],
  );

  return { viewed, loading, error, toggle, markAllViewed };
}
