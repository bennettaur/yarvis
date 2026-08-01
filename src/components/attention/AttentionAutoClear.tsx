import { useAttentionAutoClear } from "../../lib/attentionStore";

/**
 * Runs the clear-on-view pass. A component rather than a hook call in `App` so
 * the two store subscriptions it needs (pending items, and what's on screen)
 * stay in a leaf — subscribing the shell itself would re-render every view on
 * each incoming item and each terminal pane switch.
 */
export default function AttentionAutoClear() {
  useAttentionAutoClear();
  return null;
}
