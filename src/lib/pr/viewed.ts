import { useCallback, useEffect, useState } from "react";
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
} {
  const [viewed, setLocal] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<boolean>(ref !== null);
  const [error, setError] = useState<string | null>(null);

  // Re-run on refKey so parents that rebuild an equivalent ref object each
  // render don't re-trigger the fetch.
  const key = ref ? refKey(ref) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on refKey, not ref identity
  useEffect(() => {
    if (!ref) {
      setLocal(new Set());
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    listViewed(ref)
      .then((set) => {
        if (!live) return;
        setLocal(set);
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
      // Compute target state from the live updater (NOT from a captured
      // `viewed` closure) so rapid double-clicks always flip relative to
      // what's actually on screen, and the rollback below moves in the
      // opposite direction even after another toggle interleaves.
      let nextViewed = false;
      setLocal((prev) => {
        nextViewed = !prev.has(path);
        const next = new Set(prev);
        if (nextViewed) next.add(path);
        else next.delete(path);
        return next;
      });
      try {
        await setViewed(ref, path, nextViewed);
      } catch (e) {
        setLocal((prev) => {
          const next = new Set(prev);
          if (nextViewed) next.delete(path);
          else next.add(path);
          return next;
        });
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [ref],
  );

  return { viewed, loading, error, toggle };
}
