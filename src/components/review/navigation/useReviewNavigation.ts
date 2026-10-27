import { useCallback, useEffect, useRef } from "react";
import {
  type ReviewWorkspacePr,
  reviewChangedFiles,
  reviewFile,
  reviewSymbolSearch,
  reviewTree,
} from "../../../lib/reviewWorkspaces/api";
import type { OpenLocationHandler } from "../editor";
import type { NavigationTab } from "./location";
import {
  acquirePrNavigation,
  type PrNavigation,
  type ReviewNavigationSource,
} from "./prNavigation";

/** What navigation needs from a tab's context; a review `TabContext` satisfies it. */
export interface ReviewNavigationContext {
  workspaceId: string;
  pr: Pick<ReviewWorkspacePr, "id" | "refKey" | "headSha" | "status">;
  openTab: (tab: NavigationTab) => void;
}

/** The sidecar's review routes as a navigation source. */
export function sidecarNavigationSource(workspaceId: string, prId: string): ReviewNavigationSource {
  return {
    tree: async () => (await reviewTree(workspaceId, prId)).paths,
    changedFiles: async () =>
      (await reviewChangedFiles(workspaceId, prId)).files.map((file) => file.path),
    readFile: async (path) => {
      const file = await reviewFile(workspaceId, prId, path, "head");
      return file.binary || file.tooLarge ? null : file.content;
    },
    search: async (kind, query) =>
      (await reviewSymbolSearch(workspaceId, prId, kind, query)).matches,
  };
}

/**
 * Go-to-definition and find-references for a PR's files, for as long as the
 * calling tab is mounted. Every tab of one PR shares the same navigation; it
 * ends with the last of them. Pass the returned `onOpenLocation` to the tab's
 * `MonacoFileView` or `MonacoDiffView`: a jump into another file opens it as
 * a tab, the diff when the PR changes that file and the file otherwise.
 */
export function useReviewNavigation(ctx: ReviewNavigationContext): {
  onOpenLocation: OpenLocationHandler;
} {
  const { workspaceId } = ctx;
  const { id: prId, refKey, headSha, status } = ctx.pr;
  const openTab = useRef(ctx.openTab);
  openTab.current = ctx.openTab;
  const navigation = useRef<PrNavigation | null>(null);

  useEffect(() => {
    if (status !== "ready" || !headSha) return;
    const held = acquirePrNavigation({
      key: `${workspaceId}:${prId}:${headSha}`,
      refKey,
      prId,
      source: () => sidecarNavigationSource(workspaceId, prId),
    });
    navigation.current = held.navigation;
    return () => {
      navigation.current = null;
      held.release();
    };
  }, [workspaceId, prId, refKey, headSha, status]);

  const onOpenLocation = useCallback<OpenLocationHandler>((uri, range) => {
    void navigation.current?.open(uri, range, (tab) => openTab.current(tab));
  }, []);

  return { onOpenLocation };
}
