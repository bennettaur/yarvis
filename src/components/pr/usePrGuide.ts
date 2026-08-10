import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deletePrGuide,
  fetchPrGuide,
  generatePrGuide,
  type PrGuide,
  setPrGuideProgress,
  stepPaths,
} from "../../lib/pr/guide";
import { refKey } from "../../lib/pr/ref";
import type { PrRef } from "../../lib/pr/types";
import type { DiffFocus } from "./shared";

/** A place in the diff the guide can send the reader, without the nonce. */
export interface GuideTarget {
  path: string;
  startLine: number | null;
  endLine: number | null;
}

export interface GuideController {
  guide: PrGuide | null;
  /** The step the reader is on, or null when there is no guide. */
  step: PrGuide["steps"][number] | null;
  loading: boolean;
  /** An agent run is under way. */
  generating: boolean;
  error: string | null;
  generate: () => Promise<void>;
  next: () => void;
  back: () => void;
  goTo: (index: number) => void;
  /**
   * Sends the reader somewhere other than the current step's own lines — a
   * flagged problem, or one of the files a sanity-check step covered — without
   * moving their place in the tour.
   */
  focusOn: (target: GuideTarget) => void;
  dismiss: () => Promise<void>;
  /**
   * Where the diff should take the reader: the current step, or wherever
   * `focusOn` last pointed. Null when there is no guide.
   */
  focus: DiffFocus | null;
  /** Marks the last step's files read and ends the tour. */
  finish: () => Promise<void>;
}

/**
 * Owns a pull request's guide: loading it, running a generation, and moving
 * through the steps.
 *
 * Progress is written back to the sidecar so it survives leaving the PR — and
 * so the attention stream can show which step a review is on — but the move
 * itself is applied locally first. A step change that waited on a round trip
 * would make Next feel like it had not registered.
 *
 * `onStepRead` is handed every file a step accounted for as the reader moves
 * past it, so finishing a step ticks off its files the way reading them by hand
 * would. It is only called moving forward: going back is re-reading, not
 * un-reading.
 */
export function usePrGuide(
  prRef: PrRef,
  title?: string,
  url?: string,
  onStepRead?: (paths: string[]) => void,
): GuideController {
  const [guide, setGuide] = useState<PrGuide | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  // Where the reader was last sent, when that is not the current step's own
  // lines. Cleared by any move through the tour, so Next always goes back to
  // following the steps.
  const [target, setTarget] = useState<GuideTarget | null>(null);

  const key = refKey(prRef);
  // Read through a ref so the load effect can key on the PR's identity alone.
  const refValue = useRef(prRef);
  refValue.current = prRef;

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the ref identity, not the unstable ref object
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    // A place the reader was sent belongs to the pull request they were sent it
    // in. The detail view is reused across PRs rather than remounted, so without
    // this a finding clicked in one is still the focus in the next.
    setTarget(null);
    fetchPrGuide(refValue.current)
      .then((loaded) => {
        if (!active) return;
        setGuide(loaded);
        setLoading(false);
      })
      .catch((e) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [key]);

  const generate = useCallback(async () => {
    // A generation is an agent run of tens of seconds, and the detail view is
    // reused across PRs rather than remounted. Without pinning the identity the
    // result of one PR's run lands in whichever PR is on screen when it returns.
    const started = refKey(refValue.current);
    const current = () => refKey(refValue.current) === started;
    setGenerating(true);
    setError(null);
    try {
      const created = await generatePrGuide(refValue.current, title, url);
      if (!current()) return;
      setGuide(created);
      setTarget(null);
      setFocusNonce((n) => n + 1);
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (current()) setGenerating(false);
    }
  }, [title, url]);

  // The moves below read the current guide from a ref rather than from a state
  // updater: persisting progress is a side effect, and an updater can run more
  // than once for a single change, which would fire it twice.
  const latest = useRef<PrGuide | null>(null);
  latest.current = guide;

  // Read through a ref for the same reason the moves below do: marking files
  // viewed is a side effect, and it belongs to the move rather than to a render.
  const stepRead = useRef(onStepRead);
  stepRead.current = onStepRead;

  const goTo = useCallback((index: number) => {
    const current = latest.current;
    if (!current) return;
    const clamped = Math.max(0, Math.min(index, current.steps.length - 1));
    setGuide({ ...current, currentStep: clamped });
    setTarget(null);
    setFocusNonce((n) => n + 1);
    // Persisting is fire-and-forget: losing a progress write costs the reader
    // their place on a later visit, which is not worth blocking the move or
    // interrupting them with an error over.
    void setPrGuideProgress(refValue.current, clamped).catch((e) => {
      console.error("[pr] could not save guide progress:", e);
    });
  }, []);

  const next = useCallback(() => {
    const current = latest.current;
    if (!current) return;
    // Every file the step accounted for, not only the one it points at: a
    // sanity check that read all the test files finishes all of them at once.
    const finished = current.steps[current.currentStep];
    if (finished) stepRead.current?.(stepPaths(finished));
    goTo(current.currentStep + 1);
  }, [goTo]);

  const back = useCallback(() => goTo((latest.current?.currentStep ?? 0) - 1), [goTo]);

  const focusOn = useCallback((to: GuideTarget) => {
    setTarget(to);
    setFocusNonce((n) => n + 1);
  }, []);

  const dismiss = useCallback(async () => {
    setGuide(null);
    try {
      await deletePrGuide(refValue.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /**
   * Ends the tour, crediting the step the reader finished on. Reaching the last
   * step is how a guide is meant to end, and its files — often a whole sanity
   * check's worth of them — would otherwise be the only ones the tour never
   * ticked off, since there is no step after them to move past.
   */
  const finish = useCallback(async () => {
    const current = latest.current;
    const last = current?.steps[current.currentStep];
    if (last) stepRead.current?.(stepPaths(last));
    await dismiss();
  }, [dismiss]);

  const step = guide?.steps[guide.currentStep] ?? null;

  const focus = useMemo(() => {
    const to =
      target ??
      (step ? { path: step.path, startLine: step.startLine, endLine: step.endLine } : null);
    return to ? { ...to, nonce: focusNonce } : null;
  }, [target, step, focusNonce]);

  return {
    guide,
    step,
    loading,
    generating,
    error,
    generate,
    next,
    back,
    goTo,
    focusOn,
    dismiss,
    finish,
    focus,
  };
}
