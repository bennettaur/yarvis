import { useCallback, useEffect, useState } from "react";
import type { OpenReviewRequest } from "../lib/nav";
import ReviewWorkspaceList from "./review/ReviewWorkspaceList";
import ReviewWorkspaceView from "./review/ReviewWorkspaceView";
import {
  forgetReviewWorkspace,
  readSelectedWorkspace,
  writeSelectedWorkspace,
} from "./review/selection";

/**
 * The Review tab: the list of review workspaces, or the one being reviewed.
 * The open workspace is remembered, so coming back to the tab (or the app)
 * lands where the review was left rather than on the list.
 */
export default function ReviewPanel({
  requested,
  onRequestConsumed,
}: {
  requested: OpenReviewRequest | null;
  onRequestConsumed: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(readSelectedWorkspace);
  const [focusPrId, setFocusPrId] = useState<string | undefined>(undefined);

  const select = useCallback((id: string | null) => {
    setSelected(id);
    writeSelectedWorkspace(id);
  }, []);

  useEffect(() => {
    if (!requested) return;
    select(requested.workspaceId);
    setFocusPrId(requested.prId);
    onRequestConsumed();
  }, [requested, select, onRequestConsumed]);

  const clearFocus = useCallback(() => setFocusPrId(undefined), []);

  if (!selected) return <ReviewWorkspaceList onSelect={select} />;
  return (
    <ReviewWorkspaceView
      key={selected}
      workspaceId={selected}
      focusPrId={focusPrId}
      onFocusHandled={clearFocus}
      onBack={() => select(null)}
      onArchived={() => {
        forgetReviewWorkspace(selected);
        select(null);
      }}
    />
  );
}
