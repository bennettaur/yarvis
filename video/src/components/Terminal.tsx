import { useCurrentFrame } from "remotion";
import { caretOn, typed } from "../lib/timing";

export interface TermLine {
  /** Frame the line appears. */
  at: number;
  text: string;
  /** Tailwind text colour class. */
  colorClass?: string;
  /** Type the line out rather than printing it at once. */
  typeOut?: boolean;
  cps?: number;
}

/**
 * Scripted terminal output in the look of the app's xterm panes. Lines print
 * at their frame; a typed line shows a caret while it types, and the last one
 * keeps it, like a waiting prompt.
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
      {visible.map((line, i) => {
        const text = line.typeOut ? typed(line.text, frame, line.at, line.cps ?? 40) : line.text;
        const typing = line.typeOut && text.length < line.text.length;
        return (
          // Lines only ever append, and blank lines repeat, so the index is the stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only script
          <div key={i} className={`whitespace-pre ${line.colorClass ?? ""}`}>
            {text}
            {(typing || (line === last && line.typeOut)) && caretOn(frame) && (
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
    { at, text: `╭${"─".repeat(width - 2)}╮`, colorClass: "text-orange-300" },
    { at, text: row("✻ Welcome to Claude Code!"), colorClass: "text-orange-300" },
    { at, text: row(""), colorClass: "text-orange-300" },
    {
      at,
      text: row("  /help for help, /status for your current setup"),
      colorClass: "text-orange-300",
    },
    { at, text: row(""), colorClass: "text-orange-300" },
    { at, text: row(`  cwd: ${cwd}`), colorClass: "text-orange-300" },
    { at, text: `╰${"─".repeat(width - 2)}╯`, colorClass: "text-orange-300" },
    { at, text: " " },
  ];
}
