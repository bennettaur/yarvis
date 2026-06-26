import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useId, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { attachPty, killPty, onPtyExit, onPtyOutput, resizePty, writePty } from "../lib/pty";

/** Coalesce ResizeObserver bursts (a window/panel drag fires at frame rate). */
const RESIZE_DEBOUNCE_MS = 80;

/**
 * A live shell rendered with xterm.js, backed by a persistent PTY in the Rust
 * core (`lib/pty.ts`). The session is keyed by `sessionId` and survives this
 * component unmounting (tab switch, Omni layout change): on mount we reattach
 * and replay the captured scrollback rather than spawning a new shell.
 *
 * `sessionId` is namespaced by source — `tab:` for the standalone tab, `omni:`
 * for an Omni widget, `auto:` for the fallback below — so ids chosen
 * independently by different surfaces can never collide on one shell. It should
 * be stable for a given terminal. When absent (the Omni model omitted it), we
 * fall back to a per-instance id so terminals never share a shell; such a
 * session resets only if Omni itself unmounts.
 */
export default function TerminalPanel({
  sessionId,
  cwd,
  initialCommand,
}: {
  sessionId?: string;
  /** Working directory for a freshly spawned shell (ignored on reattach). */
  cwd?: string;
  /** Command to run once when the shell is first spawned (not on reattach). */
  initialCommand?: string;
}) {
  const autoId = useId();
  const id = sessionId ?? `auto:${autoId}`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  // cwd/initialCommand only apply at first spawn; refs let the attach effect read
  // them without re-running when they change — the session is keyed by id alone.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const initialCommandRef = useRef(initialCommand);
  initialCommandRef.current = initialCommand;
  const [exited, setExited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the restart control to tear down and re-attach a fresh session.
  const [_generation, setGeneration] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
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

    const dataSub = term.onData((data) => void writePty(id, data));
    cleanups.push(() => dataSub.dispose());

    void (async () => {
      try {
        // Subscribe before attaching so output emitted between shell spawn and
        // listener registration is buffered rather than lost. Once the
        // scrollback replay completes we flush and switch to writing live.
        let ready = false;
        const pending: Uint8Array[] = [];
        const unOutput = await onPtyOutput(id, (bytes) => {
          if (ready) term.write(bytes);
          else pending.push(bytes);
        });
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

        const scrollback = await attachPty(id, term.cols, term.rows, cwdRef.current);
        if (disposed) return;
        // Synchronous from here, so no buffered event can interleave. A fresh
        // shell has no scrollback, so flush the buffer; on a reattach the
        // scrollback is authoritative, so drop the buffer to avoid duplicating
        // bytes already in the snapshot.
        const fresh = scrollback.length === 0;
        if (!fresh) term.write(new Uint8Array(scrollback));
        else for (const chunk of pending) term.write(chunk);
        pending.length = 0;
        ready = true;
        void resizePty(id, term.cols, term.rows);
        // Run the one-shot command only on a fresh spawn so a tab switch
        // (reattach) doesn't re-run it.
        const initialCommand = initialCommandRef.current;
        if (fresh && initialCommand) void writePty(id, `${initialCommand}\r`);
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastCols = term.cols;
    let lastRows = term.rows;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          fit.fit();
          // Only notify the PTY when the grid actually changed.
          if (term.cols !== lastCols || term.rows !== lastRows) {
            lastCols = term.cols;
            lastRows = term.rows;
            void resizePty(id, term.cols, term.rows);
          }
        } catch {
          // Ignore transient sizing errors during layout changes.
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);
    cleanups.push(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
    });

    term.focus();

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      term.dispose();
      // The PTY session is intentionally left running so it survives unmount;
      // it is ended only by the restart control or app exit.
    };
  }, [id]);

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
