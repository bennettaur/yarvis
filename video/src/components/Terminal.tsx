import { useCurrentFrame } from "remotion";
import { caretOn, typed } from "../lib/timing";

export interface TermLine {
  /** Frame the line appears. */
  at: number;
  text: string;
  /** Tailwind text colour class. */
  tone?: string;
  /** Type the line out rather than printing it at once. */
  type?: boolean;
  cps?: number;
}

/**
 * Scripted terminal output in the look of the app's xterm panes. Lines print
 * at their frame; typed lines show a caret while they are being typed.
 */
export function Terminal({
  lines,
  className = "",
  spinnerFrom,
  spinnerLabel = "Working…",
}: {
  lines: TermLine[];
  className?: string;
  /** Show Claude Code's working line from this frame on. */
  spinnerFrom?: number;
  spinnerLabel?: string;
}) {
  const frame = useCurrentFrame();
  const visible = lines.filter((l) => frame >= l.at);
  const last = visible[visible.length - 1];
  const spinner = ["✢", "✳", "✶", "✻", "✽"][Math.floor(frame / 4) % 5];

  return (
    <div
      className={`flex flex-col justify-end overflow-hidden bg-[#0b0b0e] px-4 py-3 text-[13px] leading-[1.55] text-zinc-300 ${className}`}
      // Menlo carries the box-drawing glyphs, so borders line up.
      style={{ fontFamily: "Menlo, monospace" }}
    >
      {visible.map((line) => {
        const text = line.type ? typed(line.text, frame, line.at, line.cps ?? 40) : line.text;
        const typing = line.type && text.length < line.text.length;
        return (
          <div key={`${line.at}-${line.text}`} className={`whitespace-pre ${line.tone ?? ""}`}>
            {text}
            {(typing || (line === last && line.type)) && caretOn(frame) && (
              <span className="bg-zinc-300 text-transparent">_</span>
            )}
          </div>
        );
      })}
      {spinnerFrom !== undefined && frame >= spinnerFrom && (
        <div className="mt-1 whitespace-pre text-orange-300">
          {spinner} {spinnerLabel} <span className="text-zinc-500">(esc to interrupt)</span>
        </div>
      )}
    </div>
  );
}

/** Claude Code's welcome box, as lines for {@link Terminal}. */
export function claudeWelcome(at: number, cwd: string): TermLine[] {
  const width = 58;
  const row = (s: string) => `│ ${s.padEnd(width - 4)} │`;
  return [
    { at, text: `╭${"─".repeat(width - 2)}╮`, tone: "text-orange-300" },
    { at, text: row("✻ Welcome to Claude Code!"), tone: "text-orange-300" },
    { at, text: row(""), tone: "text-orange-300" },
    { at, text: row("  /help for help, /status for your current setup"), tone: "text-orange-300" },
    { at, text: row(""), tone: "text-orange-300" },
    { at, text: row(`  cwd: ${cwd}`), tone: "text-orange-300" },
    { at, text: `╰${"─".repeat(width - 2)}╯`, tone: "text-orange-300" },
    { at, text: " " },
  ];
}
