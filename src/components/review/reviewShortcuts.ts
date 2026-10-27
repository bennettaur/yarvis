import type { ShortcutEvent } from "../shell/useTabShortcuts";

export type ReviewShortcut =
  | "next-tab"
  | "prev-tab"
  | "close-tab"
  | "other-group"
  | "next-file"
  | "prev-file";

/**
 * Whether a key press is going into something the user types in, where Option
 * makes characters and Cmd+W shouldn't throw away what they wrote. The review
 * editor is read-only, so the element Monaco takes keys through doesn't count;
 * a comment box inside the editor's view zones does.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.matches(".monaco-editor .inputarea, .monaco-editor .native-edit-context")) {
    return false;
  }
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA";
}

/**
 * Maps a key press on the Review tab to what it does there. Cmd+1…9 and
 * Cmd+Shift+[ / ] already move between the app's views, so tabs cycle on
 * Ctrl+Tab and Cmd+Option+arrows (an editor's habits) instead. Files step on
 * Option+J / K, read from `code` because Option turns the letter into a symbol
 * on a Mac keyboard.
 */
export function resolveReviewShortcut(e: ShortcutEvent & { code: string }): ReviewShortcut | null {
  const mod = e.metaKey || e.ctrlKey;
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
    return e.shiftKey ? "prev-tab" : "next-tab";
  }
  if (mod && e.altKey && !e.shiftKey) {
    if (e.key === "ArrowRight") return "next-tab";
    if (e.key === "ArrowLeft") return "prev-tab";
    return null;
  }
  if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    if (e.key.toLowerCase() === "w") return "close-tab";
    if (e.key === "\\") return "other-group";
    return null;
  }
  if (e.altKey && !mod && !e.shiftKey) {
    if (e.code === "KeyJ") return "next-file";
    if (e.code === "KeyK") return "prev-file";
  }
  return null;
}
