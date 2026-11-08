import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { type AttentionItem, hasAnswerDialog, headsDownQuestionId } from "../../lib/attention";
import { nextAnswerable } from "../../lib/attentionGroups";
import { getAttentionSnapshot } from "../../lib/attentionStore";
import { AUTO_OPEN_ARMING_MS } from "./PermissionRequestModal";

/** How a dialog came to open. A click aims at it; anything else may catch a stray click. */
export type OpenedBy = "click" | "auto";

/**
 * Which answer dialog is open (question, heads-down or Claude Code permission),
 * and the chaining between them: once a dialog has nothing left to answer, the
 * workspace's next prompt opens in its place, so a stack of them doesn't need a
 * trip to the bell each.
 *
 * @param pending The pending attention items; the attention store's by default.
 */
export function useAnswerDialogs(pending: () => AttentionItem[] = getAttentionSnapshot) {
  const [questionItem, setQuestionItem] = useState<AttentionItem | null>(null);
  const [headsDownItem, setHeadsDownItem] = useState<AttentionItem | null>(null);
  const [permissionItem, setPermissionItem] = useState<AttentionItem | null>(null);
  // A dialog that opened without a click ignores clicks for longer.
  const [openedBy, setOpenedBy] = useState<OpenedBy>("click");

  /** Opens the item's dialog. False when the item has none, so the caller can navigate instead. */
  const open = useCallback((item: AttentionItem, by: OpenedBy): boolean => {
    if (!hasAnswerDialog(item)) return false;
    if (headsDownQuestionId(item)) setHeadsDownItem(item);
    else if (item.kind === "question") setQuestionItem(item);
    else setPermissionItem(item);
    setOpenedBy(by);
    return true;
  }, []);

  // What is on screen now. A reply can finish after the user closed its dialog
  // or opened another, and must not close or chain from that one.
  const questionItemRef = useRef(questionItem);
  const permissionItemRef = useRef(permissionItem);
  // Layout effect: synced before a late reply's promise can run against them.
  useLayoutEffect(() => {
    questionItemRef.current = questionItem;
    permissionItemRef.current = permissionItem;
  }, [questionItem, permissionItem]);

  const openNext = useCallback(
    (done: AttentionItem) => {
      const next = nextAnswerable(pending(), done);
      // The pointer is still over the button that answered the last one.
      if (next) open(next, "auto");
    },
    [pending, open],
  );

  // Neither marks the item resolved: the sidecar does that once nothing from the
  // session is waiting, which the client can't check without racing a new ask.
  const finishQuestion = useCallback(() => {
    const done = questionItem;
    if (!done || questionItemRef.current?.id !== done.id) return;
    setQuestionItem(null);
    openNext(done);
  }, [questionItem, openNext]);

  const finishPermission = useCallback(() => {
    const done = permissionItem;
    if (!done || permissionItemRef.current?.id !== done.id) return;
    setPermissionItem(null);
    openNext(done);
  }, [permissionItem, openNext]);

  const closeQuestion = useCallback(() => setQuestionItem(null), []);
  const closeHeadsDown = useCallback(() => setHeadsDownItem(null), []);
  const closePermission = useCallback(() => setPermissionItem(null), []);

  return {
    questionItem,
    headsDownItem,
    permissionItem,
    anyOpen: questionItem !== null || headsDownItem !== null || permissionItem !== null,
    /** For the question and permission dialogs; undefined keeps their own default. */
    armingMs: openedBy === "auto" ? AUTO_OPEN_ARMING_MS : undefined,
    open,
    finishQuestion,
    finishPermission,
    closeQuestion,
    closeHeadsDown,
    closePermission,
  };
}
