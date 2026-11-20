import { useCallback, useMemo, useRef, useState } from "react";
import { invalidate, prDetailKey } from "../../../lib/pr/cache";
import {
  askAboutLines,
  deletePrInsight,
  fetchPrInsights,
  type PrInsight,
  postInsight,
} from "../../../lib/pr/insights";
import { refKey } from "../../../lib/pr/ref";
import type { PrRef } from "../../../lib/pr/types";
import { primeCache, SIDECAR_FRESHNESS, useCachedResource } from "../../../lib/resourceCache";
import type { InsightsController, LineSelection } from "../../pr/usePrInsights";

export const reviewInsightsKey = (ref: PrRef) => `review-ws:insights:${refKey(ref)}`;

/**
 * A PR's line insights for the review workspace, shaped like the classic
 * review's `usePrInsights` so `InsightBlock` renders them unchanged. The list
 * lives in the shared cache rather than in the hook, because every diff tab of
 * the PR shows from the same list and opening one shouldn't refetch it. The
 * open question is the tab's own.
 */
export function useReviewInsights(prRef: PrRef): InsightsController {
  const key = reviewInsightsKey(prRef);
  const resource = useCachedResource(key, () => fetchPrInsights(prRef), SIDECAR_FRESHNESS);
  const [asking, setAsking] = useState<LineSelection | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refValue = useRef(prRef);
  refValue.current = prRef;

  const update = useCallback(
    (change: (current: PrInsight[]) => PrInsight[]) =>
      primeCache<PrInsight[]>(key, (current) => change(current ?? [])),
    [key],
  );

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
        update((current) => [created, ...current]);
        setAsking(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(false);
      }
    },
    [asking, update],
  );

  const post = useCallback(
    async (id: string) => {
      try {
        const posted = await postInsight(id);
        update((current) => current.map((i) => (i.id === id ? posted : i)));
        // Posting made a review thread; fetch it so it shows beside the answer.
        invalidate(prDetailKey(refValue.current));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [update],
  );

  const remove = useCallback(
    async (id: string) => {
      update((current) => current.filter((i) => i.id !== id));
      try {
        await deletePrInsight(id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [update],
  );

  const closeAsk = useCallback(() => setAsking(null), []);
  const openAsk = useCallback((selection: LineSelection) => {
    setError(null);
    setAsking(selection);
  }, []);

  const byPath = useMemo(() => {
    const map = new Map<string, PrInsight[]>();
    for (const insight of resource.data ?? []) {
      const list = map.get(insight.path);
      if (list) list.push(insight);
      else map.set(insight.path, [insight]);
    }
    return map;
  }, [resource.data]);

  return useMemo(
    () => ({
      byPath,
      loading: resource.loading,
      error: error ?? resource.error,
      asking,
      openAsk,
      closeAsk,
      pending,
      submit,
      post,
      remove,
    }),
    [
      byPath,
      resource.loading,
      resource.error,
      error,
      asking,
      openAsk,
      closeAsk,
      pending,
      submit,
      post,
      remove,
    ],
  );
}
