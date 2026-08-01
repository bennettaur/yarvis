import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  askAboutLines,
  deletePrInsight,
  fetchPrInsights,
  type PrInsight,
  postInsight,
} from "../../lib/pr/insights";
import { refKey } from "../../lib/pr/ref";
import type { PrRef } from "../../lib/pr/types";

/** The lines a question is being asked about. */
export interface LineSelection {
  path: string;
  startLine: number;
  endLine: number;
  /** The selected lines' text, sent so the agent sees what the reader sees. */
  selection: string;
}

export interface InsightsController {
  /** Insights bucketed by file, so a diff can find its own without scanning. */
  byPath: Map<string, PrInsight[]>;
  loading: boolean;
  error: string | null;
  /** The lines the composer is open against, if any. */
  asking: LineSelection | null;
  openAsk: (selection: LineSelection) => void;
  closeAsk: () => void;
  /** True while the agent is working on the open question. */
  pending: boolean;
  submit: (question: string) => Promise<void>;
  post: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

function bucket(insights: PrInsight[]): Map<string, PrInsight[]> {
  const map = new Map<string, PrInsight[]>();
  for (const insight of insights) {
    const list = map.get(insight.path);
    if (list) list.push(insight);
    else map.set(insight.path, [insight]);
  }
  return map;
}

/**
 * Owns a pull request's line insights: loading them, asking a new question, and
 * the two things that can be done with an answer afterwards.
 *
 * A question is an agent run, so the composer stays open and marked pending for
 * its duration rather than closing optimistically — there is nothing to show in
 * its place until the answer arrives, and closing would leave the reader
 * wondering whether it registered.
 */
export function usePrInsights(prRef: PrRef): InsightsController {
  const [insights, setInsights] = useState<PrInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<LineSelection | null>(null);
  const [pending, setPending] = useState(false);

  const key = refKey(prRef);
  const refValue = useRef(prRef);
  refValue.current = prRef;

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the ref identity, not the unstable ref object
  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchPrInsights(refValue.current)
      .then((loaded) => {
        if (!active) return;
        setInsights(loaded);
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

  const submit = useCallback(
    async (question: string) => {
      const target = asking;
      if (!target || !question.trim()) return;
      setPending(true);
      setError(null);
      try {
        const created = await askAboutLines(refValue.current, {
          ...target,
          question: question.trim(),
        });
        setInsights((current) => [created, ...current]);
        setAsking(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(false);
      }
    },
    [asking],
  );

  const post = useCallback(async (id: string) => {
    try {
      const posted = await postInsight(id);
      setInsights((current) => current.map((i) => (i.id === id ? posted : i)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    // Dropped locally first: the row is the reviewer's own note, and a failed
    // delete leaving it on screen would read as the button not working.
    setInsights((current) => current.filter((i) => i.id !== id));
    try {
      await deletePrInsight(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return {
    byPath: useMemo(() => bucket(insights), [insights]),
    loading,
    error,
    asking,
    openAsk: setAsking,
    closeAsk: () => setAsking(null),
    pending,
    submit,
    post,
    remove,
  };
}
