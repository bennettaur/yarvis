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

/** The held PRs a stack doesn't already account for, so it is looked up once. */
export function notInStack(refs: PrRef[], stack: PrStack | null): PrRef[] {
  const inStack = new Set((stack?.entries ?? []).filter(hasPullRequest).map((e) => refKey(e.ref)));
  return refs.filter((r) => !inStack.has(refKey(r)));
}

/** Ticked to start with unless someone has already approved it. */
export const pickedByDefault = (entry: StackEntry): boolean => entry.reviewDecision !== "approved";

interface PickerProps {
  heldRefKeys: ReadonlySet<string>;
  /** True while any add runs, so no picker can start a second one. */
  adding: boolean;
  onAdd: (refs: PrRef[]) => Promise<void>;
}

/**
 * One picker per stack the workspace's PRs belong to. Each walk of a stack is
 * a GitHub round trip per layer, so the stacks are looked up one at a time and
 * a held PR an earlier stack already lists isn't looked up again.
 */
export default function StackLayers({ refs, ...picker }: PickerProps & { refs: PrRef[] }) {
  const first = refs[0] ?? null;
  const { data, loading } = usePrStack(first);
  // Wait for this stack before looking up the next, or they all start at once.
  if (!first || (loading && !data)) return null;
  const stack = data ?? null;
  return (
    <>
      {stack && <StackPicker stack={stack} {...picker} />}
      <StackLayers refs={notInStack(refs.slice(1), stack)} {...picker} />
    </>
  );
}

/**
 * Lists a stack's open layers the workspace doesn't hold so the reviewer can
 * choose which to pull in. Approved layers start unticked, since they usually
 * aren't worth a checkout.
 */
function StackPicker({ stack, heldRefKeys, adding, onAdd }: PickerProps & { stack: PrStack }) {
  const layers = addableLayers(stack, heldRefKeys);
  // Only what the user changed; everything else follows `pickedByDefault`.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  if (layers.length === 0) return null;

  const isPicked = (e: StackEntry) => overrides.get(refKey(e.ref)) ?? pickedByDefault(e);
  const picked = layers.filter(isPicked);
  const toggle = (e: StackEntry) =>
    setOverrides((prev) => new Map(prev).set(refKey(e.ref), !isPicked(e)));
  const addLayers = (entries: StackEntry[]) => onAdd(entries.map((e) => e.ref));

  return (
    <section className="border-b border-zinc-800 px-3 py-2" aria-label="Stack">
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
    </section>
  );
}
