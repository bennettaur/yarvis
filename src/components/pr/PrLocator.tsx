import { useEffect, useState } from "react";
import { ghPrSummary } from "../../lib/pr/github";
import { type KnownRepo, resolvePrLocator } from "../../lib/pr/locate";
import { refDisplayRepo, refNumber } from "../../lib/pr/ref";
import type { PrRef, PrSummary } from "../../lib/pr/types";
import { listRepos } from "../../lib/repos";

/** Idle, resolving, or holding something the user needs to see. */
type LocatorState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  /** A bare repo name that matched more than one registered owner. */
  | { kind: "ambiguous"; refs: PrRef[] };

const HINT = "PR link, owner/repo#123, or repo#123";

/**
 * Jump straight to a PR the user can already name. PRs are usually shared in
 * Slack as a link or as "repo #123", so this takes either and opens the review
 * view, rather than requiring the PR to turn up in one of the lists first.
 *
 * Registered repos are loaded so a bare `repo#123` resolves without its owner;
 * the owner-qualified and link forms work regardless.
 */
export default function PrLocator({ onOpen }: { onOpen: (pr: PrSummary) => void }) {
  const [input, setInput] = useState("");
  const [knownRepos, setKnownRepos] = useState<KnownRepo[]>([]);
  const [state, setState] = useState<LocatorState>({ kind: "idle" });

  // A failed repo load only costs the bare-`repo#123` shorthand, so it stays
  // silent rather than showing an error above an input that still works.
  useEffect(() => {
    let live = true;
    listRepos()
      .then((repos) => {
        if (live) setKnownRepos(repos.map((r) => ({ owner: r.owner, repo: r.repo })));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const open = async (ref: PrRef) => {
    setState({ kind: "loading" });
    try {
      const summary = await ghPrSummary(ref);
      setInput("");
      setState({ kind: "idle" });
      onOpen(summary);
    } catch (e) {
      setState({
        kind: "error",
        message: `Couldn't open ${refDisplayRepo(ref)}#${refNumber(ref)}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
  };

  const submit = () => {
    const matches = resolvePrLocator(input, knownRepos);
    if (matches.length === 0) {
      setState({ kind: "error", message: `Not a PR reference. Try a ${HINT}.` });
      return;
    }
    if (matches.length > 1) {
      setState({ kind: "ambiguous", refs: matches });
      return;
    }
    void open(matches[0]!);
  };

  return (
    <div>
      <div className="flex gap-2">
        <input
          value={input}
          placeholder={HINT}
          onChange={(e) => {
            setInput(e.target.value);
            setState({ kind: "idle" });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
        />
        <button
          onClick={submit}
          disabled={state.kind === "loading"}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:text-zinc-600"
        >
          {state.kind === "loading" ? "Opening…" : "Open"}
        </button>
      </div>
      {state.kind === "error" && <p className="mt-1.5 text-sm text-red-400">{state.message}</p>}
      {state.kind === "ambiguous" && (
        <div className="mt-1.5 space-y-1">
          <p className="text-sm text-zinc-400">Several repos match — which one?</p>
          <div className="flex flex-wrap gap-2">
            {state.refs.map((ref) => (
              <button
                key={`${refDisplayRepo(ref)}#${refNumber(ref)}`}
                onClick={() => void open(ref)}
                className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
              >
                {refDisplayRepo(ref)}#{refNumber(ref)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
