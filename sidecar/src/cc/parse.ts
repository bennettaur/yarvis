/**
 * Pure parsers for Claude Code's ~/.claude data formats. Kept free of filesystem
 * access so they can be unit-tested with fixtures.
 *
 * Session transcripts are JSONL: one JSON object per line. Message lines have
 * type "user"/"assistant" with a `message` field; other line types carry
 * session metadata (custom-title, last-prompt, etc.).
 */

export interface SessionSummary {
  id: string | null;
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  messageCount: number;
  cwd: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  updatedAt: string | null;
}

export interface TranscriptEntry {
  role: string;
  text: string;
  timestamp: string | null;
}

export interface HistoryEntry {
  display: string;
  project: string | null;
  timestamp: number | null;
}

function parseLines(content: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines rather than failing the whole transcript.
    }
  }
  return out;
}

/** Extracts readable text from a message's `content` (string or block array). */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block?.type === "tool_use") {
      parts.push(`[tool: ${block.name ?? "?"}]`);
    } else if (block?.type === "tool_result") {
      parts.push("[tool result]");
    }
  }
  return parts.join("\n").trim();
}

export function parseSessionSummary(content: string): SessionSummary {
  const summary: SessionSummary = {
    id: null,
    title: null,
    firstPrompt: null,
    lastPrompt: null,
    messageCount: 0,
    cwd: null,
    gitBranch: null,
    startedAt: null,
    updatedAt: null,
  };

  for (const obj of parseLines(content)) {
    if (obj.sessionId && !summary.id) summary.id = obj.sessionId;

    if (typeof obj.timestamp === "string") {
      if (!summary.startedAt || obj.timestamp < summary.startedAt) {
        summary.startedAt = obj.timestamp;
      }
      if (!summary.updatedAt || obj.timestamp > summary.updatedAt) {
        summary.updatedAt = obj.timestamp;
      }
    }

    switch (obj.type) {
      case "custom-title":
        if (obj.customTitle) summary.title = obj.customTitle;
        break;
      case "last-prompt":
        if (obj.lastPrompt) summary.lastPrompt = obj.lastPrompt;
        break;
      case "user":
      case "assistant": {
        summary.messageCount++;
        if (!summary.cwd && obj.cwd) summary.cwd = obj.cwd;
        if (!summary.gitBranch && obj.gitBranch) summary.gitBranch = obj.gitBranch;
        if (
          obj.type === "user" &&
          !summary.firstPrompt &&
          typeof obj.message?.content === "string"
        ) {
          summary.firstPrompt = obj.message.content;
        }
        break;
      }
    }
  }

  return summary;
}

export function parseTranscript(content: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const obj of parseLines(content)) {
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    const text = extractText(obj.message?.content);
    if (!text) continue;
    entries.push({
      role: obj.message?.role ?? obj.type,
      text,
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : null,
    });
  }
  return entries;
}

export interface ActivityTurn {
  text: string;
  timestamp: string | null;
}

export interface RecentActivity {
  /** The newest prompts the user typed, oldest first. */
  prompts: ActivityTurn[];
  /** The agent's newest text reply, which says where the work got to. */
  lastReply: ActivityTurn | null;
  lastActivityAt: string | null;
}

/**
 * Text Claude Code writes into a user line that the user didn't type: slash
 * command plumbing, its output, injected reminders, IDE context and the
 * interrupt marker.
 */
const INJECTED_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-",
  "<system-reminder>",
  "<ide_",
  "<user-prompt-submit-hook>",
  "Caveat:",
  "[Request interrupted",
];

function typedText(content: unknown): string {
  const blocks =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? content
        : [];
  // A line carrying a tool result is the harness replying to the agent, even
  // when it also has text in it.
  if (blocks.some((b) => b?.type === "tool_result")) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const text = block.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    if (!text || INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix))) continue;
    parts.push(text);
  }
  return parts.join("\n").trim();
}

/**
 * What a session was most recently doing: the last prompts the user typed, with
 * tool traffic and harness-injected lines dropped, and the agent's last reply.
 * Subagent (sidechain) lines and compaction summaries are skipped, since neither
 * is the user talking to the session.
 */
export function parseRecentActivity(content: string, promptLimit: number): RecentActivity {
  const prompts: ActivityTurn[] = [];
  let lastReply: ActivityTurn | null = null;
  let lastActivityAt: string | null = null;

  for (const obj of parseLines(content)) {
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : null;
    if (timestamp && (!lastActivityAt || timestamp > lastActivityAt)) lastActivityAt = timestamp;
    if (obj.isSidechain || obj.isMeta || obj.isCompactSummary) continue;

    if (obj.type === "user") {
      const text = typedText(obj.message?.content);
      if (text) prompts.push({ text, timestamp });
    } else {
      const content = obj.message?.content;
      const text = Array.isArray(content)
        ? content
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("\n")
            .trim()
        : typeof content === "string"
          ? content.trim()
          : "";
      if (text) lastReply = { text, timestamp };
    }
  }

  return { prompts: prompts.slice(-promptLimit), lastReply, lastActivityAt };
}

export function parseHistory(content: string, limit = 50): HistoryEntry[] {
  const entries = parseLines(content).map((obj) => ({
    display: typeof obj.display === "string" ? obj.display : "",
    project: typeof obj.project === "string" ? obj.project : null,
    timestamp: typeof obj.timestamp === "number" ? obj.timestamp : null,
  }));
  return entries.reverse().slice(0, limit);
}

/** First markdown H1, falling back to null. */
export function parsePlanTitle(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const match = line.match(/^#\s+(.+)$/);
    if (match) return match[1]?.trim();
  }
  return null;
}
