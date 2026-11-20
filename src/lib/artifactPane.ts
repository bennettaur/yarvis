import { createContext, useCallback, useState } from "react";

/**
 * Opens an artifact in the pane of the chat a link was clicked in. Provided by
 * each chat surface; with none (a link outside any chat), the link asks the
 * App shell to open it beside the Chat tab.
 */
export const ArtifactPaneContext = createContext<((id: string) => void) | null>(null);

/** Which artifact a chat surface shows beside its conversation, if any. */
export function useArtifactPane(): {
  openId: string | null;
  open: (id: string) => void;
  close: () => void;
} {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = useCallback((id: string) => setOpenId(id), []);
  const close = useCallback(() => setOpenId(null), []);
  return { openId, open, close };
}
