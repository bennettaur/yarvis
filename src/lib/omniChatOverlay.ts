import { createContext, useContext } from "react";

/**
 * Whether the Omni Chat overlay is currently covering the app.
 *
 * The overlay renders above whatever surface is on screen, and `ChatPanel` is
 * one of them — both as the Chat tab and as an Omni widget. Both mount a
 * `ToolApprovalBar` with a `window` keydown listener, so without this an `A`
 * meant for the overlay's approval would answer for the covered surface too.
 */
const OmniChatOverlayContext = createContext(false);

export const OmniChatOverlayProvider = OmniChatOverlayContext.Provider;

/** True while the overlay is open, i.e. while covered surfaces are not reachable. */
export function useOmniChatOverlayOpen(): boolean {
  return useContext(OmniChatOverlayContext);
}
