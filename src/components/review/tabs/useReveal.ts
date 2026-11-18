import { useState } from "react";

/**
 * The line a file tab's editor should show, and a key that changes every time
 * it should be scrolled to again. Two things ask: the tab's spec (re-opened at
 * a line, with a new nonce each time) and the tab itself (a must-read's
 * "jump"). Whichever asked last wins.
 */
export function useReveal(
  revealLine: number | undefined,
  revealNonce: number | undefined,
): { line: number | undefined; key: number; jump: (line: number) => void } {
  const asked = `${revealLine}:${revealNonce ?? 0}`;
  const [seen, setSeen] = useState(asked);
  const [reveal, setReveal] = useState({ line: revealLine, key: 0 });
  // Adjusting state while rendering, as React documents for state that follows
  // a prop: the editor gets the new line in the same pass, not one effect later.
  if (seen !== asked) {
    setSeen(asked);
    setReveal((r) => ({ line: revealLine, key: r.key + 1 }));
  }
  return {
    line: reveal.line,
    key: reveal.key,
    jump: (line) => setReveal((r) => ({ line, key: r.key + 1 })),
  };
}
