import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import {
  attachPty,
  killPty,
  onPtyExit,
  onPtyOutput,
  type PtyOutput,
  resizePty,
  writePty,
} from "../lib/pty";

/** Handle exposed via `panelRef` so a parent (e.g. TerminalTabs) can move keyboard focus into the xterm. */
export interface TerminalPanelHandle {
  focus: () => void;
}

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
  embedded,
  onFocusRequested,
  panelRef,
}: {
  sessionId?: string;
  /** Working directory for a freshly spawned shell (ignored on reattach). */
  cwd?: string;
  /** Command to run once when the shell is first spawned (not on reattach). */
  initialCommand?: string;
  /** When true, omit the per-instance chrome (restart button, exit badge) so a
   * parent surface like TerminalTabs can own the controls. */
  embedded?: boolean;
  /** Fires when the terminal gains keyboard focus (via click or programmatic
   * focus) — used by TerminalTabs to track which pane the user is in. */
  onFocusRequested?: () => void;
  /** Imperative handle (see {@link TerminalPanelHandle}). */
  panelRef?: React.Ref<TerminalPanelHandle>;
}) {
  const autoId = useId();
  const id = sessionId ?? `auto:${autoId}`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  useImperativeHandle(panelRef, () => ({
    focus: () => termRef.current?.focus(),
  }));
  // Latest focus callback without re-running the attach effect; the effect only
  // depends on the session id.
  const onFocusRef = useRef(onFocusRequested);
  onFocusRef.current = onFocusRequested;
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
    // True only while xterm is parsing the replayed scrollback. Set here so both
    // the onData handler and the attach effect below can see it.
    let replayingScrollback = false;
    const cleanups: Array<() => void> = [];

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
      fontSize: 13,
      theme: { background: "#09090b", foreground: "#e4e4e7" },
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === "Enter" && e.shiftKey && e.type === "keydown") {
        // Claude Code's TUI treats a bare line feed the same as Enter
        // (submit). It only inserts a newline for the Meta/Option+Enter
        // sequence — ESC followed by carriage return — which is what its own
        // /terminal-setup binds Shift+Enter to in iTerm2/VSCode.
        void writePty(id, "\x1b\r");
        return false;
      }
      return true;
    });
    const focusSub = term.textarea
      ? (() => {
          const ta = term.textarea;
          const handler = () => onFocusRef.current?.();
          ta?.addEventListener("focus", handler);
          return () => ta?.removeEventListener("focus", handler);
        })()
      : null;
    if (focusSub) cleanups.push(focusSub);
    try {
      fit.fit();
    } catch {
      // The container can be zero-sized on first paint; the ResizeObserver
      // below fits it once it has dimensions.
    }

    const dataSub = term.onData((data) => {
      // While replaying captured scrollback, xterm answers the app's original
      // terminal queries (see the reattach path below). Those replies are stale
      // and must not reach the PTY, so drop everything for the replay's duration.
      if (replayingScrollback) return;
      void writePty(id, data);
    });
    cleanups.push(() => dataSub.dispose());

    void (async () => {
      try {
        // Subscribe before attaching so output emitted between shell spawn and
        // listener registration is buffered rather than lost. Buffering is what
        // makes the splice below possible: the offset to write from is only known
        // once the snapshot arrives, and writing a chunk before then would advance
        // the cursor past bytes the replay is about to cover.
        let ready = false;
        const pending: PtyOutput[] = [];
        // Stream offset this terminal has been fed up to, exclusive. Chunks are
        // written from here on, so bytes the snapshot accounts for are never
        // written twice and bytes captured after it was taken are never dropped.
        // Dropping one loses it for good: for an idle Claude Code session the
        // chunk in that window is the repaint of its input box and status line,
        // which then stay blank until something else redraws them.
        let writtenEndOffset = 0;
        const writeNewBytes = ({ offset, bytes }: PtyOutput) => {
          const end = offset + bytes.length;
          if (end <= writtenEndOffset) return;
          // Negative when the chunk starts past what we have (a dropped event),
          // where writing the whole chunk beats writing nothing.
          term.write(bytes.subarray(Math.max(writtenEndOffset - offset, 0)));
          writtenEndOffset = end;
        };
        const unOutput = await onPtyOutput(id, (chunk) => {
          if (ready) writeNewBytes(chunk);
          else pending.push(chunk);
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

        const { scrollback, endOffset } = await attachPty(id, term.cols, term.rows, cwdRef.current);
        if (disposed) return;
        // Synchronous from here, so no buffered event can interleave. A shell
        // that has produced nothing is one this attach just spawned. `endOffset`
        // does not answer that — a session replacing a dead one under the same id
        // carries the dead one's offsets forward, so it starts above zero.
        const fresh = scrollback.length === 0;
        if (!fresh) {
          // Replaying the snapshot re-feeds the app's original terminal queries
          // (Device Attributes, DECRQM, OSC color) to xterm's parser, which
          // answers each one via onData. Those queries were already answered
          // during the live session, so gate onData until the parser drains the
          // replay — otherwise the stale replies leak into the PTY as stray
          // input (e.g. `[?1;2c]11;rgb:...`), the garbage seen on reattach.
          replayingScrollback = true;
          term.write(new Uint8Array(scrollback), () => {
            replayingScrollback = false;
          });
        }
        writtenEndOffset = endOffset;
        for (const chunk of pending) writeNewBytes(chunk);
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
      termRef.current = null;
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
      {!embedded && (
        <div className="flex shrink-0 items-center justify-end gap-2 px-2 py-1">
          {exited && <span className="text-xs text-zinc-500">exited</span>}
          <button
            type="button"
            onClick={restart}
            title="Kill the shell and start a fresh session"
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            Restart
          </button>
        </div>
      )}
      {error && <p className="px-2 pb-1 text-xs text-red-400">{error}</p>}
      {embedded && exited && <p className="px-2 py-0.5 text-xs text-zinc-500">[process exited]</p>}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden px-2 pb-2" />
    </div>
  );
}
