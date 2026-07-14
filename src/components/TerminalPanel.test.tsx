import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToHtml } from "../test/render";

const encoder = new TextEncoder();
// Terminal queries an app emits: a Primary Device Attributes request (`ESC [ c`)
// and an OSC 11 background-color query (`ESC ] 11 ; ? ESC \`). xterm's parser
// answers each of these — a DA reply of `[?1;2c` and an OSC reply of `]11;rgb:…`
// — which is exactly what the bug leaked into the PTY on reattach.
const QUERY_BYTES = "\x1b[c\x1b]11;?\x1b\\";

// mock.module must register at top level, so the stubs record into module-scoped
// state that beforeEach resets between tests.
let scrollbackToReturn: number[] = [];
const writes: string[] = [];
let resizeCalls = 0;
let ptyOutput: ((bytes: Uint8Array) => void) | null = null;

mock.module("../lib/pty", () => ({
  attachPty: async () => scrollbackToReturn,
  writePty: async (_id: string, data: string) => {
    writes.push(data);
  },
  resizePty: async () => {
    resizeCalls += 1;
  },
  killPty: async () => {},
  onPtyOutput: async (_id: string, cb: (bytes: Uint8Array) => void) => {
    ptyOutput = cb;
    return () => {};
  },
  onPtyExit: async () => () => {},
}));

// Imported after the mock is registered so the component binds to the stubs.
const { default: TerminalPanel } = await import("./TerminalPanel");

/** Mounts and lets effects/async settle, but stays mounted so a test can drive
 * live PTY output; returns an unmount cleanup. `renderToHtml` unmounts before it
 * returns, which the reattach-then-input test below cannot use. */
async function mountSettled(element: ReactElement, settleMs = 120): Promise<() => void> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(element);
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  return () => {
    root.unmount();
    host.remove();
  };
}

beforeEach(() => {
  scrollbackToReturn = [];
  writes.length = 0;
  resizeCalls = 0;
  ptyOutput = null;
});

describe("TerminalPanel scrollback replay", () => {
  it("does not leak xterm's query replies into the PTY during replay", async () => {
    scrollbackToReturn = Array.from(encoder.encode(`hi\r\n${QUERY_BYTES}`));

    await renderToHtml(createElement(TerminalPanel, { sessionId: "tab:replay" }));

    // resizePty runs immediately after the replay, confirming the attach path
    // actually executed and parsed the scrollback (rather than the mock silently
    // doing nothing).
    expect(resizeCalls).toBeGreaterThan(0);

    // The replay must not send the app's stale query answers back to the shell.
    const sent = writes.join("");
    expect(sent).not.toContain("[?1;2c");
    expect(sent).not.toContain("]11;rgb");
  });

  it("re-opens the gate so live query replies still reach the PTY after replay", async () => {
    scrollbackToReturn = Array.from(encoder.encode(`hi\r\n${QUERY_BYTES}`));

    const unmount = await mountSettled(createElement(TerminalPanel, { sessionId: "tab:reopen" }));
    try {
      // Replay has settled; drop any replay-era writes so the assertion below
      // only sees what the *live* query produces.
      writes.length = 0;
      expect(ptyOutput).not.toBeNull();

      // The app re-queries after reattach; that arrives as live output, and its
      // reply must be forwarded — proving the gate did not stay shut and swallow
      // real terminal traffic (which would silently drop all subsequent input).
      ptyOutput?.(new Uint8Array(encoder.encode("\x1b[c")));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(writes.join("")).toContain("[?1;2c");
    } finally {
      unmount();
    }
  });

  it("forwards the initial command on a fresh spawn without gating", async () => {
    scrollbackToReturn = []; // empty scrollback => fresh shell, not a reattach

    await renderToHtml(
      createElement(TerminalPanel, { sessionId: "tab:fresh", initialCommand: "echo hello" }),
    );

    // A fresh spawn is never gated, so the one-shot command reaches the PTY.
    expect(writes.join("")).toContain("echo hello\r");
  });
});
