import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { refDisplayRepo, refKey, refNumber } from "../../lib/pr/ref";
import type { PrSummary } from "../../lib/pr/types";
import { invalidatePrefix, primeCache } from "../../lib/resourceCache";
import {
  addReviewPr,
  archiveReviewWorkspace,
  followReviewPrProgress,
  openReviewWorkspace,
  type ReviewWorkspace,
  type ReviewWorkspacePr,
  renameReviewWorkspace,
} from "../../lib/reviewWorkspaces/api";
import {
  invalidateReviewWorkspace,
  REVIEW_WORKSPACES_KEY,
  reviewWorkspaceKey,
  useReviewChangedFiles,
  useReviewWorkspace,
} from "../../lib/reviewWorkspaces/cache";
import PrLocator from "../pr/PrLocator";
import SplitPane, { usePersistedRatio } from "../SplitPane";
import ConfirmDialog from "./ConfirmDialog";
import { prColor } from "./prColors";
import ReviewNav, { prLabel } from "./ReviewNav";
import ReviewPrBar from "./ReviewPrBar";
import ReviewTabGroups from "./ReviewTabGroups";
import { isTextEntry, resolveReviewShortcut } from "./reviewShortcuts";
import SetupConsentDialog from "./SetupConsentDialog";
import { changedFileOrder } from "./tabs/DiffTab";
import {
  activeTab,
  adjacentPath,
  closeTab,
  cycleTab,
  loadLayout,
  moveActiveToOtherGroup,
  openTab,
  pruneTabs,
  saveLayout,
  type TabLayout,
} from "./tabs/tabLayout";
import { type StaticTabKind, type TabContext, type TabSpec, tabId } from "./tabs/types";

const DIFF_MODE_KEY = "yarvis.review.diffMode";

function useDiffMode(): ["split" | "unified", (mode: "split" | "unified") => void] {
  const [mode, setMode] = useState<"split" | "unified">(() => {
    try {
      return localStorage.getItem(DIFF_MODE_KEY) === "unified" ? "unified" : "split";
    } catch {
      return "split";
    }
  });
  const set = useCallback((m: "split" | "unified") => {
    setMode(m);
    try {
      localStorage.setItem(DIFF_MODE_KEY, m);
    } catch {
      // Non-fatal: the choice just won't stick.
    }
  }, []);
  return [mode, set];
}

/**
 * What a tab's title starts with: "#12" when every PR is from one repo, since
 * the number is then enough and the strip has little room; "repo#12" otherwise.
 */
export function tabPrefix(pr: ReviewWorkspacePr, prs: ReviewWorkspacePr[]): string {
  const oneRepo = prs.every((p) => refDisplayRepo(p.ref) === refDisplayRepo(pr.ref));
  return oneRepo ? `#${refNumber(pr.ref)}` : prLabel(pr);
}

/** Whether anything about the workspace is still moving, so it is worth asking again. */
export function isSettling(ws: Pick<ReviewWorkspace, "status" | "prs">): boolean {
  return (
    ws.status === "archiving" ||
    ws.prs.some(
      (pr) =>
        pr.status === "pending" ||
        pr.status === "cloning" ||
        pr.worktreeStatus === "pending" ||
        pr.worktreeStatus === "checking-out" ||
        pr.setupStatus === "running",
    )
  );
}

/**
 * The latest clone log line per cloning PR, followed live, so the PR's header
 * in the nav says what the clone is doing rather than only that it is.
 */
function useCloneProgress(
  workspaceId: string,
  prs: ReviewWorkspacePr[],
  onDone: () => void,
): ReadonlyMap<string, string> {
  const [lines, setLines] = useState<ReadonlyMap<string, string>>(new Map());
  const cloning = prs
    .filter((p) => p.status === "pending" || p.status === "cloning")
    .map((p) => p.id)
    .join(",");
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!cloning) return;
    // One controller for the set: a PR finishing or another starting changes
    // `cloning`, which closes these streams and opens the ones now wanted.
    const abort = new AbortController();
    for (const prId of cloning.split(",")) {
      void (async () => {
        try {
          for await (const event of followReviewPrProgress(workspaceId, prId, abort.signal)) {
            if (event.type === "log") {
              const line = event.text.trim().split("\n").pop()?.trim();
              if (line) setLines((m) => new Map(m).set(prId, line));
            } else if (event.type === "done") {
              onDoneRef.current();
            }
          }
        } catch {
          // The poll still picks up the outcome; the log line is a nicety.
        }
      })();
    }
    return () => abort.abort();
  }, [workspaceId, cloning]);
  return lines;
}

/**
 * One review workspace: the PRs' nav on the left, tabs on the right, and the
 * bar for the PR in front above them. The nav and description show as soon as
 * the workspace row is read; the clones fill in behind.
 */
export default function ReviewWorkspaceView({
  workspaceId,
  focusPrId,
  focusTab = "description",
  onFocusHandled,
  onBack,
  onArchived,
}: {
  workspaceId: string;
  /** A PR to bring forward once the workspace has loaded. */
  focusPrId?: string;
  /** Which of its tabs to open. */
  focusTab?: StaticTabKind;
  onFocusHandled: () => void;
  onBack: () => void;
  onArchived: () => void;
}) {
  const res = useReviewWorkspace(workspaceId);
  const ws = res.data;
  const prs = useMemo(() => ws?.prs ?? [], [ws]);
  const [layout, setLayout] = useState<TabLayout>(() => loadLayout(workspaceId));
  const [diffMode, setDiffMode] = useDiffMode();
  const [navRatio, setNavRatio] = usePersistedRatio("yarvis.review.navRatio", 0.2);
  const [consentPr, setConsentPr] = useState<ReviewWorkspacePr | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const readOnly = ws ? ws.status !== "active" : false;

  const update = useCallback((fn: (l: TabLayout) => TabLayout) => setLayout(fn), []);
  useEffect(() => saveLayout(workspaceId, layout), [workspaceId, layout]);
  const open = useCallback((spec: TabSpec) => update((l) => openTab(l, spec)), [update]);

  const refresh = res.refresh;

  // A workspace that no longer exists (deleted elsewhere, or a stale saved
  // selection) sends the tab back to the list rather than a dead end.
  const missing = !ws && res.error !== null && /\(404\)/.test(res.error);
  useEffect(() => {
    if (missing) onBack();
  }, [missing, onBack]);
  const progress = useCloneProgress(workspaceId, prs, () => void refresh());

  // Ordering the list by last opened is the sidecar's; a failure only costs that.
  useEffect(() => {
    openReviewWorkspace(workspaceId).catch(() => undefined);
  }, [workspaceId]);

  // Poll while a clone, checkout or setup is moving, since only some of those
  // have a stream, and none says when the next one starts.
  const settling = ws ? isSettling(ws) : false;
  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [settling, refresh]);

  // A PR removed elsewhere takes its tabs with it, and an empty layout opens on
  // the first PR's description so there is always something to read at once.
  const loaded = ws !== null;
  const prIds = prs.map((p) => p.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on which PRs there are, not on every poll's fresh rows
  useEffect(() => {
    if (!loaded) return;
    update((l) => {
      const pruned = pruneTabs(l, new Set(prs.map((p) => p.id)));
      const first = [...prs].sort((a, b) => a.position - b.position)[0];
      const isEmpty = pruned.groups.every((g) => g.tabs.length === 0);
      return isEmpty && first ? openTab(pruned, { kind: "description", prId: first.id }) : pruned;
    });
  }, [loaded, prIds, update]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-checked when the PRs change, since the one asked for may arrive late
  useEffect(() => {
    if (!focusPrId || !prs.some((p) => p.id === focusPrId)) return;
    open({ kind: focusTab, prId: focusPrId });
    onFocusHandled();
  }, [focusPrId, focusTab, prIds, open, onFocusHandled]);

  const current = activeTab(layout);
  const frontPr = prs.find((p) => p.id === current?.prId) ?? prs[0] ?? null;
  const changed = useReviewChangedFiles(workspaceId, frontPr);

  // One context per PR, rebuilt only when that PR's row or the diff mode
  // changes, so the memoised tab bodies of other PRs stay put.
  const contexts = useRef(new Map<string, TabContext>());
  const contextFor = useCallback(
    (prId: string): TabContext | null => {
      const pr = prs.find((p) => p.id === prId);
      if (!pr) return null;
      const held = contexts.current.get(prId);
      if (held && held.pr === pr && held.diffMode === diffMode && held.openTab === open) {
        return held;
      }
      const ctx: TabContext = {
        workspaceId,
        pr,
        prRef: pr.ref,
        diffMode,
        openTab: open,
        openSetup: () => setConsentPr(pr),
      };
      contexts.current.set(prId, ctx);
      return ctx;
    },
    [prs, workspaceId, diffMode, open],
  );
  const ownerOf = useCallback(
    (prId: string) => {
      const pr = prs.find((p) => p.id === prId);
      return pr ? { color: prColor(pr.colorIndex), label: tabPrefix(pr, prs) } : null;
    },
    [prs],
  );

  // Keyboard: answered only while focus is inside the workspace, like the
  // terminal surface, and never for a key a text field is waiting for.
  const changedPaths = useMemo(
    () => (changed.data ? changedFileOrder(changed.data.files) : []),
    [changed.data],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!root.current?.contains(document.activeElement)) return;
      const action = resolveReviewShortcut(e);
      if (!action) return;
      const typing = isTextEntry(e.target);
      if (typing && (action === "close-tab" || action === "next-file" || action === "prev-file")) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      switch (action) {
        case "next-tab":
        case "prev-tab":
          update((l) => cycleTab(l, action === "next-tab" ? 1 : -1));
          break;
        case "close-tab":
          update((l) => {
            const t = activeTab(l);
            return t ? closeTab(l, tabId(t)) : l;
          });
          break;
        case "other-group":
          update(moveActiveToOtherGroup);
          break;
        case "next-file":
        case "prev-file": {
          if (!frontPr) break;
          const here =
            current?.kind === "diff" && current.prId === frontPr.id ? current.path : null;
          const path = adjacentPath(changedPaths, here, action === "next-file" ? 1 : -1);
          if (path) open({ kind: "diff", prId: frontPr.id, path });
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [update, open, frontPr, current, changedPaths]);

  const attempt = async (op: () => Promise<void>) => {
    setError(null);
    try {
      await op();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const addPr = (summary: PrSummary) =>
    attempt(async () => {
      const existing = prs.find((p) => p.refKey === refKey(summary.ref));
      if (existing) {
        open({ kind: "description", prId: existing.id });
        return;
      }
      const pr = await addReviewPr(workspaceId, summary.ref);
      // Shown straight away: the row is all the nav and description need.
      if (ws) primeCache(reviewWorkspaceKey(workspaceId), { ...ws, prs: [...ws.prs, pr] });
      invalidatePrefix(REVIEW_WORKSPACES_KEY);
      // The rest of the PR's stack came along with it.
      void refresh();
      open({ kind: "description", prId: pr.id });
    });

  const archive = async () => {
    await archiveReviewWorkspace(workspaceId);
    invalidateReviewWorkspace(workspaceId);
    onArchived();
  };

  const commitRename = () =>
    attempt(async () => {
      const name = renaming?.trim();
      setRenaming(null);
      if (!ws || !name || name === ws.name) return;
      primeCache(reviewWorkspaceKey(workspaceId), await renameReviewWorkspace(workspaceId, name));
      invalidateReviewWorkspace(workspaceId);
    });

  if (!ws) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-500">
        <p className={res.error ? "text-red-400" : undefined}>
          {res.error ?? "Loading review workspace…"}
        </p>
        {res.error && (
          <button
            type="button"
            onClick={onBack}
            className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            All review workspaces
          </button>
        )}
      </div>
    );
  }

  const split = layout.groups.length > 1;
  const nav = (
    <ReviewNav
      workspaceId={workspaceId}
      prs={prs}
      active={current}
      progress={progress}
      openTab={open}
      onSetup={setConsentPr}
    />
  );
  const main = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {frontPr && (
        <ReviewPrBar
          key={frontPr.id}
          workspaceId={workspaceId}
          pr={frontPr}
          color={prColor(frontPr.colorIndex)}
          readOnly={readOnly}
          openTab={(kind) => open({ kind, prId: frontPr.id })}
          onChanged={() => void refresh()}
        />
      )}
      <div className="min-h-0 flex-1">
        <ReviewTabGroups
          layout={layout}
          onChange={update}
          contextFor={contextFor}
          ownerOf={ownerOf}
          showOwner={prs.length > 1}
          empty={
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">
              Pick a section or a file on the left.
            </div>
          }
        />
      </div>
    </div>
  );

  return (
    <div ref={root} className="relative flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          title="All review workspaces"
          aria-label="All review workspaces"
          className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:bg-zinc-800"
        >
          ←
        </button>
        {renaming !== null ? (
          <input
            value={renaming}
            aria-label="Workspace name"
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename();
              if (e.key === "Escape") setRenaming(null);
            }}
            ref={(el) => el?.focus()}
            className="w-56 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm"
          />
        ) : (
          <button
            type="button"
            onClick={() => !readOnly && setRenaming(ws.name)}
            title={readOnly ? ws.name : "Rename"}
            className="max-w-64 truncate text-sm font-medium text-zinc-100 hover:text-indigo-200"
          >
            {ws.name}
          </button>
        )}
        {readOnly && (
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">{ws.status}</span>
        )}
        <div className="mx-2 min-w-48 max-w-md flex-1">
          {!readOnly && <PrLocator onOpen={(s) => void addPr(s)} actionLabel="Add PR" />}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <fieldset
            className="flex overflow-hidden rounded-md border border-zinc-700 text-xs"
            aria-label="Diff layout"
          >
            {(["unified", "split"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={diffMode === m}
                onClick={() => setDiffMode(m)}
                className={`px-2 py-1 ${diffMode === m ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800"}`}
              >
                {m === "unified" ? "Unified" : "Split"}
              </button>
            ))}
          </fieldset>
          <button
            type="button"
            onClick={() => update(moveActiveToOtherGroup)}
            aria-pressed={split}
            title="Move the tab to the other side (⌘\\)"
            className={`rounded-md border px-2 py-1 text-xs ${
              split ? "border-indigo-500 text-indigo-200" : "border-zinc-700 text-zinc-300"
            } hover:bg-zinc-800`}
          >
            Side by side
          </button>
          {!readOnly && (
            <button
              type="button"
              onClick={() => setConfirmingArchive(true)}
              title="Remove the checkouts and put this workspace away"
              className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Archive
            </button>
          )}
        </div>
      </header>
      {(error || ws.error) && (
        <p className="shrink-0 border-b border-zinc-800 px-3 py-1 text-xs text-red-400">
          {error ?? ws.error}
        </p>
      )}
      <SplitPane
        className="min-h-0 flex-1"
        orientation="horizontal"
        ratio={navRatio}
        onRatioChange={setNavRatio}
        minRatio={0.12}
        first={nav}
        second={main}
      />
      {confirmingArchive && (
        <ConfirmDialog
          title={`Archive “${ws.name}”?`}
          confirmLabel="Archive"
          busyLabel="Archiving…"
          onConfirm={archive}
          onClose={() => setConfirmingArchive(false)}
        >
          Removes the PRs' checkouts from disk and puts the workspace under Show archived. The
          clones are kept, so reviewing the same repos again starts faster.
        </ConfirmDialog>
      )}
      {consentPr && (
        <SetupConsentDialog
          workspaceId={workspaceId}
          pr={consentPr}
          onClose={() => setConsentPr(null)}
          onAnswered={() => {
            setConsentPr(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
