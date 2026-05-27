import { useEffect, useId, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  attachPty,
  killPty,
  onPtyExit,
  onPtyOutput,
  resizePty,
  writePty,
} from "../lib/pty";

/**
 * A live shell rendered with xterm.js, backed by a persistent PTY in the Rust
 * core (`lib/pty.ts`). The session is keyed by `sessionId` and survives this
 * component unmounting (tab switch, Omni layout change): on mount we reattach
 * and replay the captured scrollback rather than spawning a new shell.
 *
 * `sessionId` should be stable for a given terminal. The standalone tab passes
 * a constant; Omni passes the model-assigned id. When absent (model omitted
 * it), we fall back to a per-instance id so terminals never share a shell —
 * such a session resets only if Omni itself unmounts.
 */
export default function TerminalPanel({ sessionId }: { sessionId?: string }) {
  const autoId = useId();
  const id = sessionId ?? `auto:${autoId}`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [exited, setExited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the restart control to tear down and re-attach a fresh session.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
      fontSize: 13,
      theme: { background: "#09090b", foreground: "#e4e4e7" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      // The container can be zero-sized on first paint; the ResizeObserver
      // below fits it once it has dimensions.
    }

    void (async () => {
      try {
        const { scrollback } = await attachPty(id, term.cols, term.rows);
        if (disposed) return;
        if (scrollback.length) term.write(new Uint8Array(scrollback));
        // Align the PTY with the actual viewport now that it is laid out.
        void resizePty(id, term.cols, term.rows);

        const unOutput = await onPtyOutput(id, (bytes) => term.write(bytes));
        const unExit = await onPtyExit(id, () => {
          setExited(true);
          term.writeln("\r\n\x1b[2m[process exited]\x1b[0m");
        });
        if (disposed) {
          unOutput();
          unExit();
          return;
        }
        cleanups.push(unOutput, unExit);
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    const dataSub = term.onData((data) => void writePty(id, data));
    cleanups.push(() => dataSub.dispose());

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        void resizePty(id, term.cols, term.rows);
      } catch {
        // Ignore transient sizing errors during layout changes.
      }
    });
    observer.observe(container);
    cleanups.push(() => observer.disconnect());

    term.focus();

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      term.dispose();
      // The PTY session is intentionally left running so it survives unmount;
      // it is ended only by the restart control or app exit.
    };
  }, [id, generation]);

  const restart = () => {
    void killPty(id).finally(() => {
      setExited(false);
      setError(null);
      setGeneration((g) => g + 1);
    });
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[#09090b]">
      <div className="flex shrink-0 items-center justify-end gap-2 px-2 py-1">
        {exited && <span className="text-xs text-zinc-500">exited</span>}
        <button
          onClick={restart}
          title="Kill the shell and start a fresh session"
          className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          Restart
        </button>
      </div>
      {error && <p className="px-2 pb-1 text-xs text-red-400">{error}</p>}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden px-2 pb-2" />
    </div>
  );
}
