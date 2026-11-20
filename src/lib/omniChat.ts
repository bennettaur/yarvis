import type { UnlistenFn } from "@tauri-apps/api/event";
import { onNativeEvent } from "./core";

/** localStorage key under which Omni Chat's persistent session id is kept. */
export const OMNI_CHAT_SESSION_KEY = "yarvis.omnichat.sessionId";

/**
 * Subscribe to the global-shortcut summon emitted by the Rust core. The window
 * is already focused by the time this fires; the handler opens the overlay.
 */
export const onOmniChatSummon = (cb: () => void): Promise<UnlistenFn> =>
  onNativeEvent("omni-chat-summon", cb);
