import { usePrStack } from "../../../lib/pr/cache";
import { refKey } from "../../../lib/pr/ref";
import { hasPullRequest } from "../../../lib/pr/stack";
import type { PrRef, PrStack, StackEntry } from "../../../lib/pr/types";

/**
 * The layers of a stack the workspace could add: open pull requests it doesn't
 * hold yet, bottom first. A merged layer's change is already in the trunk, and
 * a branch with no PR has nothing to check out.
 */
export function addableLayers(stack: PrStack, heldRefKeys: ReadonlySet<string>): StackEntry[] {
  return stack.entries.filter(
    (e) => hasPullRequest(e) && e.state === "open" && !heldRefKeys.has(refKey(e.ref)),
  );
}

/** The held PRs this stack doesn't list, so no stack is looked up twice. */
export function notInStack(refs: PrRef[], stack: PrStack | null): PrRef[] {
  const inStack = new Set((stack?.entries ?? []).map((e) => refKey(e.ref)));
  return refs.filter((r) => !inStack.has(refKey(r)));
}

/** Ticked to start with unless someone has already approved it. */
export const pickedByDefault = (entry: StackEntry): boolean => entry.reviewDecision !== "approved";

interface PickerProps {
  heldRefKeys: ReadonlySet<string>;
  adding: boolean;
  /** Ticks the reviewer changed, by ref key; the rest follow `pickedByDefault`. */
  overrides: ReadonlyMap<string, boolean>;
  onToggle: (key: string, picked: boolean) => void;
  onAdd: (refs: PrRef[]) => Promise<void>;
}

/**
 * One picker per stack the workspace's PRs belong to. Each walk of a stack is
 * a GitHub round trip per layer, so the stacks are looked up one at a time and
 * a held PR an earlier stack already lists isn't looked up again.
 */
export default function StackLayers({ refs, ...picker }: PickerProps & { refs: PrRef[] }) {
  const first = refs[0] ?? null;
  const { data: stack, loading, error } = usePrStack(first);
  // Wait for this stack before looking up the next, or they all start at once.
  // A failed lookup ends the chain: the next held PR is usually in the same
  // stack, and walking it again would hit a provider that is already failing.
  if (!first || loading || (error && !stack)) return null;
  const rest = notInStack(refs.slice(1), stack);
  return (
    <>
      {stack && <StackPicker stack={stack} {...picker} />}
      {/* Keyed by the PR it looks up, so when that PR changes it never shows the old PR's stack. */}
      <StackLayers key={rest[0] ? refKey(rest[0]) : "end"} refs={rest} {...picker} />
    </>
  );
}

/**
 * Lists a stack's open layers the workspace doesn't hold so the reviewer can
 * choose which to pull in.
 */
function StackPicker({
  stack,
  heldRefKeys,
  adding,
  overrides,
  onToggle,
  onAdd,
}: PickerProps & { stack: PrStack }) {
  const layers = addableLayers(stack, heldRefKeys);
  if (layers.length === 0) return null;

  const isPicked = (e: StackEntry) => overrides.get(refKey(e.ref)) ?? pickedByDefault(e);
  const picked = layers.filter(isPicked);
  const toggle = (e: StackEntry) => onToggle(refKey(e.ref), !isPicked(e));
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
