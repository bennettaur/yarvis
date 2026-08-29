import { useEffect, useState } from "react";
import { HINT_MODIFIER_KEY } from "./shortcuts";

/**
 * How long the modifier has to be held before the hints appear. Cmd is the first
 * key of most chords in the app, so showing them instantly would flash the rail
 * on every Cmd+C; a deliberate hold is what asks "what are my options?".
 */
const HOLD_MS = 400;

/**
 * True while the user is holding the shortcut modifier on its own — the cue for
 * the nav rail to label each view with the key that jumps to it.
 *
 * Pressing any other key ends the hold: the chord is committed, and the hint has
 * nothing left to answer. So does leaving the window, since the key-up for a
 * Cmd+Tab away never arrives.
 */
export function useShortcutHints(): boolean {
  const [holding, setHolding] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const release = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      setHolding(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== HINT_MODIFIER_KEY || e.shiftKey || e.altKey || e.ctrlKey) {
        release();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => setHolding(true), HOLD_MS);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === HINT_MODIFIER_KEY) release();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", release);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return holding;
}
