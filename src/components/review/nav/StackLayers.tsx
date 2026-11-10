import { useState } from "react";
import { usePrStack } from "../../../lib/pr/cache";
import { refKey } from "../../../lib/pr/ref";
import { hasPullRequest } from "../../../lib/pr/stack";
import type { PrRef, PrStack, StackEntry } from "../../../lib/pr/types";

/**
 * The layers of a stack the workspace could add: open pull requests it doesn't
 * hold yet, bottom first. A merged layer's change is already in the trunk, and
 * a branch with no PR has nothing to check out.
 */
export function addableLayers(stack: PrStack | null, held: ReadonlySet<string>): StackEntry[] {
  return (stack?.entries ?? []).filter(
    (e) => hasPullRequest(e) && e.state === "open" && !held.has(refKey(e.ref)),
  );
}

/**
 * Whether `ref` is the lowest layer of its stack the workspace holds. Every
 * held layer reads the same stack, so only that one offers the rest, rather
 * than the same list appearing under each of them.
 */
export function offersStack(stack: PrStack | null, ref: PrRef, held: ReadonlySet<string>): boolean {
  const lowest = (stack?.entries ?? []).find((e) => hasPullRequest(e) && held.has(refKey(e.ref)));
  return lowest !== undefined && refKey(lowest.ref) === refKey(ref);
}

/** Ticked to start with unless someone has already approved it. */
export const pickedByDefault = (entry: StackEntry): boolean => entry.reviewDecision !== "approved";

/**
 * Lists the other open layers of a PR's stack so the reviewer can choose which
 * to pull in, rather than every layer arriving uninvited. Approved layers start
 * unticked, since they usually aren't worth a checkout.
 */
export default function StackLayers({
  prRef,
  heldRefKeys,
  onAdd,
}: {
  prRef: PrRef;
  heldRefKeys: ReadonlySet<string>;
  onAdd: (refs: PrRef[]) => Promise<void>;
}) {
  const { data: stack } = usePrStack(prRef);
  const layers = offersStack(stack ?? null, prRef, heldRefKeys)
    ? addableLayers(stack ?? null, heldRefKeys)
    : [];
  // Only what the user changed; everything else follows `pickedByDefault`.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [adding, setAdding] = useState(false);
  if (layers.length === 0) return null;

  const isPicked = (e: StackEntry) => overrides.get(refKey(e.ref)) ?? pickedByDefault(e);
  const picked = layers.filter(isPicked);
  const toggle = (e: StackEntry) =>
    setOverrides((prev) => new Map(prev).set(refKey(e.ref), !isPicked(e)));
  const addLayers = async (entries: StackEntry[]) => {
    setAdding(true);
    try {
      await onAdd(entries.map((e) => e.ref));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="px-3 py-1">
      <p className="py-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
        Stack <span className="font-normal text-zinc-600">{layers.length} not added</span>
      </p>
      <ul className="space-y-0.5">
        {layers.map((e) => (
          <li key={refKey(e.ref)}>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={isPicked(e)}
                onChange={() => toggle(e)}
                disabled={adding}
              />
              <span className="shrink-0 text-xs text-zinc-500">#{e.number}</span>
              <span className="min-w-0 flex-1 truncate" title={e.title}>
                {e.title}
              </span>
              {e.reviewDecision === "approved" && (
                <span className="rounded bg-emerald-900/40 px-1.5 text-xs text-emerald-200">
                  Approved
                </span>
              )}
              {e.draft && (
                <span className="rounded bg-zinc-800 px-1.5 text-xs text-zinc-400">Draft</span>
              )}
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex gap-3 text-xs">
        <button
          type="button"
          onClick={() => addLayers(picked)}
          disabled={adding || picked.length === 0}
          className="text-indigo-300 hover:text-indigo-200 disabled:cursor-default disabled:text-zinc-600"
        >
          Add selected ({picked.length})
        </button>
        <button
          type="button"
          onClick={() => addLayers(layers)}
          disabled={adding}
          className="text-zinc-400 hover:text-zinc-200 disabled:cursor-default disabled:text-zinc-600"
        >
          Add all
        </button>
      </div>
    </div>
  );
}
