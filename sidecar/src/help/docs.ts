import configuration from "../../../docs/configuration.md" with { type: "text" };
import assistant from "../../../docs/features/assistant.md" with { type: "text" };
import calendarAndAlarms from "../../../docs/features/calendar-and-alarms.md" with { type: "text" };
import clipboard from "../../../docs/features/clipboard.md" with { type: "text" };
import issuesAndTasks from "../../../docs/features/issues-and-tasks.md" with { type: "text" };
import keyboardShortcuts from "../../../docs/features/keyboard-shortcuts.md" with { type: "text" };
import mcp from "../../../docs/features/mcp.md" with { type: "text" };
import omniView from "../../../docs/features/omni-view.md" with { type: "text" };
import prReview from "../../../docs/features/pr-review.md" with { type: "text" };
import quickChat from "../../../docs/features/quick-chat.md" with { type: "text" };
import scheduledJobs from "../../../docs/features/scheduled-jobs.md" with { type: "text" };
import telegram from "../../../docs/features/telegram.md" with { type: "text" };
import terminals from "../../../docs/features/terminals.md" with { type: "text" };
import voice from "../../../docs/features/voice.md" with { type: "text" };
import workspaces from "../../../docs/features/workspaces.md" with { type: "text" };
import gettingStarted from "../../../docs/getting-started.md" with { type: "text" };
import voiceServer from "../../../docs/voice-server.md" with { type: "text" };

/**
 * The user-facing docs, embedded so the Yarvis guide can answer "where is X?"
 * from the same pages a person would read. Imported as text so they are
 * bundled into the compiled sidecar. The developer docs (`development.md`, the
 * security review) are left out because they describe the codebase, not the app.
 *
 * Keyed by the path under `docs/` without `.md`. A link in a top-level page
 * (`features/pr-review.md`) becomes a key once `.md` is stripped; links inside
 * `features/` are relative to that folder and don't.
 */
const DOCS: Record<string, string> = {
  "getting-started": gettingStarted,
  configuration,
  "voice-server": voiceServer,
  "features/assistant": assistant,
  "features/calendar-and-alarms": calendarAndAlarms,
  "features/clipboard": clipboard,
  "features/issues-and-tasks": issuesAndTasks,
  "features/keyboard-shortcuts": keyboardShortcuts,
  "features/mcp": mcp,
  "features/omni-view": omniView,
  "features/pr-review": prReview,
  "features/quick-chat": quickChat,
  "features/scheduled-jobs": scheduledJobs,
  "features/telegram": telegram,
  "features/terminals": terminals,
  "features/voice": voice,
  "features/workspaces": workspaces,
};

export interface DocSection {
  doc: string;
  /** The heading chain down to this section, e.g. "Configuration › Secrets". */
  heading: string;
  text: string;
}

const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Splits a page at its `#` to `###` headings. Deeper headings stay inside their
 * parent section, which keeps sections big enough to answer from. Lines inside
 * code fences are never headings, since shell comments start with `#` too.
 */
export function splitSections(doc: string, markdown: string): DocSection[] {
  const sections: DocSection[] = [];
  const chain: string[] = [];
  let lines: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) sections.push({ doc, heading: chain.join(" › "), text });
    lines = [];
  };

  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    const [, hashes, title] = (inFence ? null : HEADING.exec(line)) ?? [];
    if (!hashes || !title) {
      lines.push(line);
      continue;
    }
    flush();
    chain.length = hashes.length - 1;
    chain[hashes.length - 1] = title;
  }
  flush();
  return sections;
}

let cachedSections: DocSection[] | null = null;

function allSections(): DocSection[] {
  cachedSections ??= Object.entries(DOCS).flatMap(([doc, markdown]) =>
    splitSections(doc, markdown),
  );
  return cachedSections;
}

export function docNames(): string[] {
  return Object.keys(DOCS);
}

// Beyond the usual filler words, "set", "up" and "yarvis" appear in most
// questions ("how do I set up Yarvis to…") and would match every page.
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "do",
  "does",
  "for",
  "how",
  "i",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "set",
  "the",
  "to",
  "up",
  "what",
  "where",
  "with",
  "yarvis",
]);

function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
    ),
  ];
}

function countOccurrences(haystack: string, term: string): number {
  let count = 0;
  let at = haystack.indexOf(term);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(term, at + term.length);
  }
  return count;
}

export interface DocMatch {
  doc: string;
  heading: string;
  snippet: string;
  score: number;
}

const SNIPPET_CHARS = 600;
const HEADING_WEIGHT = 4;
const MAX_BODY_HITS = 5;

/**
 * Keyword search over the doc sections. A term in a heading counts for more
 * than one in the body, and each body term is capped so a section that
 * repeats one word can't outrank one that mentions every word once. The docs
 * are small enough that a scan per query is cheap.
 */
export function searchDocs(query: string, limit = 5): DocMatch[] {
  const queryTerms = searchTerms(query);
  if (queryTerms.length === 0) return [];
  const scored: DocMatch[] = [];
  for (const section of allSections()) {
    const heading = section.heading.toLowerCase();
    const body = section.text.toLowerCase();
    let score = 0;
    let matchedTerms = 0;
    for (const term of queryTerms) {
      const inHeading = countOccurrences(heading, term);
      const inBody = Math.min(countOccurrences(body, term), MAX_BODY_HITS);
      if (inHeading || inBody) matchedTerms++;
      score += inHeading * HEADING_WEIGHT + inBody;
    }
    if (score === 0) continue;
    // Covering more of the question beats repeating one word of it.
    score *= matchedTerms / queryTerms.length;
    scored.push({
      doc: section.doc,
      heading: section.heading,
      snippet:
        section.text.length > SNIPPET_CHARS
          ? `${section.text.slice(0, SNIPPET_CHARS)}…`
          : section.text,
      score: Math.round(score * 100) / 100,
    });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// About 6k tokens: room for the longest page today (workspaces, ~20 KB) while
// keeping one tool result from crowding out the guide's own context.
const MAX_READ_CHARS = 24_000;

/**
 * One page, or the sections of it whose heading contains `section`
 * (case-insensitive). `null` when the page doesn't exist; an unmatched
 * section returns the page's headings so the caller can pick a real one.
 */
export function readDoc(
  doc: string,
  section?: string,
): { doc: string; text: string; truncated: boolean } | { doc: string; headings: string[] } | null {
  const name = doc.replace(/\.md$/, "");
  // The name is the model's choice, so `constructor` and friends must not
  // resolve to Object.prototype members.
  if (!Object.hasOwn(DOCS, name)) return null;
  const markdown = DOCS[name] as string;
  let text = markdown;
  if (section?.trim()) {
    const needle = section.trim().toLowerCase();
    const sections = splitSections(name, markdown);
    const hits = sections.filter((s) => s.heading.toLowerCase().includes(needle));
    if (hits.length === 0) return { doc: name, headings: sections.map((s) => s.heading) };
    text = hits.map((s) => `## ${s.heading}\n\n${s.text}`).join("\n\n");
  }
  const truncated = text.length > MAX_READ_CHARS;
  return { doc: name, text: truncated ? text.slice(0, MAX_READ_CHARS) : text, truncated };
}
