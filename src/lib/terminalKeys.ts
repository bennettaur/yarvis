/**
 * Key decisions for the xterm terminal that xterm.js itself gets wrong for the
 * agent TUIs we host — currently only Shift+Enter (see
 * {@link resolveTerminalKey}).
 */

/**
 * What Claude Code's TUI reads as "insert a newline instead of submitting":
 * ESC followed by carriage return, i.e. Meta/Option+Enter. Claude pushes the
 * kitty keyboard (`CSI > 1 u`) and modifyOtherKeys (`CSI > 4 ; 2 m`) modes at
 * startup without asking whether the terminal supports them, and xterm.js
 * implements neither, so the CSI-u encoding of Shift+Enter never reaches it —
 * this sequence is the encoding it does accept from a plain terminal.
 */
export const AGENT_NEWLINE_SEQUENCE = "\x1b\r";

/** How a terminal key event should be dispatched. */
export interface TerminalKeyAction {
  /** Bytes to write straight to the PTY, bypassing xterm's own encoding. */
  write?: string;
  /** False when xterm.js must not process the event itself. */
  passToXterm: boolean;
}

/** The parts of a `KeyboardEvent` the decision depends on. */
type TerminalKeyEvent = Pick<
  KeyboardEvent,
  "key" | "type" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey"
>;

const isShiftEnter = (event: TerminalKeyEvent) =>
  event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;

/**
 * Decides what a terminal key event should send.
 *
 * Shift+Enter is claimed on both `keydown` and `keypress`, and that pairing is
 * the whole point: xterm.js bails out of `_keyDown` as soon as a custom handler
 * returns false, *before* it marks the key handled and without preventing the
 * event's default. The `keypress` that follows therefore finds `_keyDownHandled`
 * false, turns Enter's charCode 13 into a bare CR, and submits the prompt —
 * right after the newline sequence we wrote on keydown. Swallowing only the
 * keydown is why the previous two attempts at this looked like no fix at all.
 *
 * `keyup` is deliberately left to xterm so it keeps refreshing focus and the
 * cursor style.
 */
export const resolveTerminalKey = (event: TerminalKeyEvent): TerminalKeyAction => {
  if (!isShiftEnter(event)) return { passToXterm: true };
  if (event.type === "keydown") return { write: AGENT_NEWLINE_SEQUENCE, passToXterm: false };
  if (event.type === "keypress") return { passToXterm: false };
  return { passToXterm: true };
};
