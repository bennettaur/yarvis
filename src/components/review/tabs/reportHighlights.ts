import {
  type Severity,
  VERIFICATION_CHECKS,
  type VerificationMustRead,
  type VerificationReport,
} from "../../../lib/reviewWorkspaces/verification";
import { type LineDecoration, plainHoverText } from "../editor";
import { CHECK_LABEL } from "./VerificationReportView";

/** One thing the verification report says about a line of a file. */
export interface FileNote {
  /** The check that raised it, "Risk" for a risk concern, or "Must read" for a must-read's flag. */
  source: string;
  title: string;
  detail: string;
  /** Absent for a risk concern or a must-read flag, which have none. */
  severity?: Severity;
  line: number;
}

/**
 * The report's findings, risk concerns and must-read flags that cite a line of
 * `path`, in line order. One with no line has nowhere to go in the diff, so it
 * stays in the report alone.
 */
export function fileNotes(report: VerificationReport | null, path: string): FileNote[] {
  if (!report) return [];
  const notes: FileNote[] = [];
  for (const flag of report.mustRead.find((m) => m.path === path)?.flags ?? []) {
    if (flag.line) {
      notes.push({ source: "Must read", title: flag.note, detail: "", line: flag.line });
    }
  }
  for (const c of report.risk.concerns) {
    if (c.path === path && c.line) {
      notes.push({ source: "Risk", title: c.title, detail: c.detail, line: c.line });
    }
  }
  for (const key of VERIFICATION_CHECKS) {
    for (const f of report[key]?.findings ?? []) {
      if (f.path === path && f.line) {
        notes.push({
          source: CHECK_LABEL[key],
          title: f.title,
          detail: f.detail,
          severity: f.severity,
          line: f.line,
        });
      }
    }
  }
  return notes.sort((a, b) => a.line - b.line);
}

/**
 * Highlights for the head side of a diff: the must-read range and each line a
 * finding cites, with the report's reason on hover. The text is the model's,
 * so it is shown as plain text, never as markdown.
 */
export function reportDecorations(
  mustRead: VerificationMustRead | null,
  notes: FileNote[],
): LineDecoration[] {
  const decorations: LineDecoration[] = [];
  if (mustRead?.lines) {
    decorations.push({
      startLine: mustRead.lines.start,
      endLine: mustRead.lines.end,
      className: "review-must-read-line",
      marginClassName: "review-must-read-margin",
      hoverMessage: plainHoverText(`Must read: ${mustRead.reason}`),
    });
  }
  for (const note of notes) {
    const severity = note.severity ? ` (${note.severity})` : "";
    decorations.push({
      startLine: note.line,
      endLine: note.line,
      className: "review-finding-line",
      marginClassName: "review-finding-margin",
      hoverMessage: plainHoverText(
        `${note.source}${severity}: ${note.title}${note.detail ? `. ${note.detail}` : ""}`,
      ),
    });
  }
  return decorations;
}
