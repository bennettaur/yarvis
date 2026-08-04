import { useCallback, useEffect, useRef, useState } from "react";
import {
  deletePrGuide,
  fetchPrGuide,
  generatePrGuide,
  type PrGuide,
  setPrGuideProgress,
} from "../../lib/pr/guide";
import { refKey } from "../../lib/pr/ref";
import type { PrRef } from "../../lib/pr/types";

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
  dismiss: () => Promise<void>;
  /**
   * Bumped every time the reader lands on a step, including re-selecting the
   * one they are already on. Consumers key their scroll-into-view on it, so
   * "take me back to where I was" works without a step change to react to.
   */
  focusNonce: number;
}

/**
 * Owns a pull request's guide: loading it, running a generation, and moving
 * through the steps.
 *
 * Progress is written back to the sidecar so it survives leaving the PR — and
 * so the attention stream can show which step a review is on — but the move
 * itself is applied locally first. A step change that waited on a round trip
 * would make Next feel like it had not registered.
 */
export function usePrGuide(prRef: PrRef, title?: string, url?: string): GuideController {
  const [guide, setGuide] = useState<PrGuide | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);

  const key = refKey(prRef);
  // Read through a ref so the load effect can key on the PR's identity alone.
  const refValue = useRef(prRef);
  refValue.current = prRef;

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the ref identity, not the unstable ref object
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
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

  const goTo = useCallback((index: number) => {
    const current = latest.current;
    if (!current) return;
    const clamped = Math.max(0, Math.min(index, current.steps.length - 1));
    setGuide({ ...current, currentStep: clamped });
    setFocusNonce((n) => n + 1);
    // Persisting is fire-and-forget: losing a progress write costs the reader
    // their place on a later visit, which is not worth blocking the move or
    // interrupting them with an error over.
    void setPrGuideProgress(refValue.current, clamped).catch((e) => {
      console.error("[pr] could not save guide progress:", e);
    });
  }, []);

  const next = useCallback(() => goTo((latest.current?.currentStep ?? 0) + 1), [goTo]);
  const back = useCallback(() => goTo((latest.current?.currentStep ?? 0) - 1), [goTo]);

  const dismiss = useCallback(async () => {
    setGuide(null);
    try {
      await deletePrGuide(refValue.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return {
    guide,
    step: guide?.steps[guide.currentStep] ?? null,
    loading,
    generating,
    error,
    generate,
    next,
    back,
    goTo,
    dismiss,
    focusNonce,
  };
}
