/**
 * Story mode: the PR read theme by theme rather than file by file, the work
 * that matters first. The chapters are the change map's themes, which the
 * sidecar already orders core, then supporting, then outliers, riskiest first
 * within each; files no theme names close the story so nothing is skipped.
 */

import type { DiffRow } from "../pr/diff";
import type { ChangeTheme, VerificationChangeMap } from "./verification";

export interface StoryChapter {
  /** The theme's position and title, or the leftovers' fixed key. */
  key: string;
  title: string;
  description: string;
  risk: ChangeTheme["risk"] | null;
  cohesion: ChangeTheme["cohesion"] | null;
  /** For an outlier, what to ask the author. */
  question: string;
  files: ChangeTheme["files"];
}

// Starts with a NUL so no theme key (`<index>:<title>`) can equal it.
const LEFTOVERS_KEY = "\u0000unmapped";

export function storyChapters(map: VerificationChangeMap): StoryChapter[] {
  const chapters: StoryChapter[] = map.themes.map((t, i) => ({
    key: `${i}:${t.title}`,
    title: t.title,
    description: t.description,
    risk: t.risk,
    cohesion: t.cohesion,
    question: t.question,
    files: t.files,
  }));
  if (map.unmapped.length > 0) {
    chapters.push({
      key: LEFTOVERS_KEY,
      title: "Everything else",
      description: "Changed files the change map didn't put in a theme.",
      risk: null,
      cohesion: null,
      question: "",
      files: map.unmapped.map((path) => ({ path })),
    });
  }
  return chapters;
}

/** A chapter is read once every file in it is marked viewed. */
export function chapterRead(chapter: StoryChapter, viewed: ReadonlySet<string>): boolean {
  return chapter.files.every((f) => viewed.has(f.path));
}

/** Where a hunk starts on the head side, from its `@@ -a,b +c,d @@` header. */
function headStart(header: string): number | null {
  const match = /\+(\d+)/.exec(header);
  return match ? Number(match[1]) : null;
}

/**
 * The hunks of a file's patch that touch `lines` on the head side, each with
 * its header row; the whole patch when there is no range. A hunk that only
 * removes lines is kept when it sits at a line inside the range, since a
 * removal is part of the theme too.
 */
export function rowsInRange(rows: DiffRow[], lines?: { start: number; end: number }): DiffRow[] {
  const shown = rows.filter((r) => r.kind !== "meta");
  if (!lines) return shown;
  const inRange = (n: number) => n >= lines.start && n <= lines.end;
  const kept: DiffRow[] = [];
  let hunk: DiffRow[] = [];
  const flush = () => {
    if (hunk.length === 0) return;
    const heads = hunk.map((r) => r.rightLine).filter((n): n is number => n !== null);
    const start = hunk[0]?.kind === "hunk" ? headStart(hunk[0].text) : null;
    const touches = heads.length > 0 ? heads.some(inRange) : start !== null && inRange(start);
    if (touches) kept.push(...hunk);
    hunk = [];
  };
  for (const row of shown) {
    if (row.kind === "hunk") flush();
    hunk.push(row);
  }
  flush();
  return kept;
}
