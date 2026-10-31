import { ensureOk, sidecarFetch, streamSSE } from "./api";
import type { ToolActivity } from "./chat";

/**
 * Client for heads-down mode (`/api/heads-down`) and the work streams it
 * pushes (`/api/work-streams`). Types mirror the sidecar's rows.
 */

export interface HeadsDownRun {
  id: string;
  focus: string | null;
  status: "active" | "stopped";
  startedAt: string;
  stoppedAt: string | null;
  /** Set while the user has paused it: no passes run until they resume. */
  pausedAt: string | null;
  /** When it stops on its own, if the user set a time. */
  stopAt: string | null;
}

export interface HeadsDownPass {
  id: string;
  runId: string;
  chatSessionId: string | null;
  startedAt: string;
  finishedAt: string | null;
  notes: string | null;
  sleepMinutes: number | null;
  sleepReason: string | null;
  error: string | null;
  /** How many tool calls the pass made. Only on the pass list. */
  callCount?: number;
  /**
   * The calls that failed, with the start of their error, and those whose
   * result never came back (`noResult`). Only on the pass list.
   */
  failedCalls?: { name: string; server: string | null; error: string | null; noResult?: boolean }[];
}

export interface HeadsDownState {
  run: HeadsDownRun | null;
  lastPass: HeadsDownPass | null;
  nextPassAt: string | null;
  openQuestionCount: number;
}

export interface HeadsDownQuestion {
  id: string;
  kind: "question" | "approval";
  streamId: string | null;
  question: string;
  situation: string | null;
  options: string[];
  action: string | null;
  toolArgs: unknown;
  status: "open" | "answered" | "dismissed";
  choice: string | null;
  answer: string | null;
  /** Null on questions not yet answered. */
  answeredBy: "user" | "decision-model" | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface HeadsDownMessage {
  id: string;
  body: string;
  createdAt: string;
  seenAt: string | null;
}

export interface WorkingHours {
  days: number[];
  start: string;
  end: string;
}

export interface HeadsDownConfig {
  minSleepMinutes: number;
  maxSleepMinutes: number;
  idleSleepMinutes: number;
  workingHours: WorkingHours | null;
  userAwayAfterMinutes: number;
  provider: string | null;
  model: string | null;
  /** The user's standing rules for every pass on this machine. Null for none. */
  guidance: string | null;
  /** The most routines one pass takes on. 0 turns them off. */
  maxRoutinesPerPass: number;
}

export type MergeRisk = "low" | "medium" | "high" | "unknown";

const MERGE_RISKS: readonly MergeRisk[] = ["low", "medium", "high", "unknown"];

/** A merge a pass announced, carried on its attention item's payload. */
export interface MergeAnnouncement {
  /** "owner/repo", or empty when the merge call didn't name one. */
  repo: string;
  /** Null when a workspace's session was told to merge, and the PR isn't known. */
  number: number | null;
  workspaceId?: string | null;
  /** The PR's own title, as the pass read it. */
  title?: string | null;
  /** The pass's own judgment; "unknown" when it merged without announcing it first. */
  risk: MergeRisk;
  why: string;
}

/** The merge an attention item announces, if it is a heads-down merge alert. */
export function mergeAnnouncementOf(item: {
  source: string;
  sessionKey: string | null;
  payload?: unknown;
}): MergeAnnouncement | null {
  if (item.source !== "system" || !item.sessionKey?.startsWith("heads-down-merge:")) return null;
  const merge = (item.payload as { headsDownMerge?: MergeAnnouncement } | null)?.headsDownMerge;
  if (!merge || !MERGE_RISKS.includes(merge.risk)) return null;
  return typeof merge.number === "number" || merge.number === null ? merge : null;
}

export type WorkStreamStatus =
  | "active"
  | "waiting-on-user"
  | "waiting-on-others"
  | "done"
  | "dropped";

export type WorkStreamLinkRef =
  | { kind: "ticket"; provider: "github" | "jira" | "azure-boards"; key: string; url?: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "pr"; provider: "github" | "azure"; url: string }
  | { kind: "message"; channel: string; conversation: string; messageRef: string; author?: string }
  | {
      kind: "review-request";
      channel: string;
      conversation: string;
      messageRef: string;
      sentAt: string;
      prUrl?: string;
      tagged?: string[];
    };

export interface WorkStreamLink {
  id: string;
  kind: WorkStreamLinkRef["kind"];
  ref: WorkStreamLinkRef;
  title: string | null;
  state: string | null;
  observedAt: string | null;
}

export interface WorkStream {
  id: string;
  title: string;
  summary: string | null;
  status: WorkStreamStatus;
  priority: "urgent" | "high" | "medium" | "low";
  nextAction: string | null;
  waitingOn: string | null;
  wakeAt: string | null;
  /** Set while the user has paused it: heads-down mode leaves it alone. */
  pausedAt: string | null;
  updatedAt: string;
  links: WorkStreamLink[];
}

/** A pass's transcript row: the prompt it started from, or what it did and said. */
export interface PassMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls: ToolActivity[] | null;
  createdAt: string;
}

/** One live update from a pass in flight; mirrors the chat stream's events. */
export type PassEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; server?: string; args?: unknown }
  | {
      type: "tool_result";
      id: string;
      status: ToolActivity["status"];
      result?: string;
      durationMs?: number;
    }
  | { type: "error"; message: string; transient?: boolean }
  | { type: "done"; text: string }
  | { type: "attention"; reason?: string };

export type HeadsDownStreamEvent =
  | { type: "pass-started"; passId: string }
  | { type: "pass-event"; passId: string; event: PassEvent }
  | { type: "pass-retrying"; passId: string; retryAt: string }
  | { type: "pass-finished"; passId: string; sleepMinutes: number; nextPassAt: string }
  | { type: "changed" }
  | { type: "ping" };

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await sidecarFetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await ensureOk(res, `${method} ${path}`);
  return res.json() as Promise<T>;
}

export const getHeadsDownState = () => request<HeadsDownState>("/api/heads-down");

/**
 * The next time the clock reads `hhmm` ("19:00"), as an ISO timestamp: today,
 * or tomorrow once today's has passed. The sidecar reads an "HH:MM" from the
 * chat the same way.
 */
export function nextOccurrence(hhmm: string, now = new Date()): string {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const at = new Date(now);
  at.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.toISOString();
}

/** Leaving `stopAt` out keeps the stop time of a run already going, rather than clearing it. */
export const startHeadsDown = (focus: string, stopAt?: string) =>
  request<HeadsDownRun>("/api/heads-down/start", "POST", stopAt ? { focus, stopAt } : { focus });

export const stopHeadsDown = () => request<{ stopped: boolean }>("/api/heads-down/stop", "POST");

/**
 * Drops every open work stream, deletes the user's messages and dismisses open
 * questions. The sidecar refuses it while a run is going and not paused.
 */
export const clearHeadsDown = () =>
  request<{ droppedStreams: number; deletedMessages: number }>("/api/heads-down/clear", "POST");

export const pauseHeadsDown = () => request<HeadsDownRun>("/api/heads-down/pause", "POST");

export const resumeHeadsDown = () => request<HeadsDownRun>("/api/heads-down/resume", "POST");

/** Sets when the run stops on its own, as an ISO timestamp, or clears it with null. */
export const setHeadsDownStopAt = (stopAt: string | null) =>
  request<HeadsDownRun>("/api/heads-down/stop-at", "PUT", { stopAt });

export const getHeadsDownConfig = () => request<HeadsDownConfig>("/api/heads-down/config");

export const saveHeadsDownConfig = (config: HeadsDownConfig) =>
  request<HeadsDownConfig>("/api/heads-down/config", "PUT", config);

/** A recurring job a pass takes on beside the work streams, read from a markdown file. */
export interface Routine {
  name: string;
  description: string;
  everyMinutes: number;
  workingHoursOnly: boolean;
  enabled: boolean;
  /** `user` for a file in the user's own folder, including one that replaces a shipped routine. */
  source: "builtin" | "user";
  /** ISO time of the last pass that reported it done. Null if none has. */
  lastDoneAt: string | null;
}

export interface RoutinesResponse {
  routines: Routine[];
  /** Files that couldn't be read as a routine, with why. */
  problems: { path: string; message: string }[];
  /** Where the user's own routine files go. */
  userDir: string;
}

export const listRoutines = () => request<RoutinesResponse>("/api/heads-down/routines");

export const reloadRoutines = () =>
  request<RoutinesResponse>("/api/heads-down/routines/reload", "POST");

/** An MCP tool heads-down mode may call without asking. */
export interface AllowedTool {
  /** Registry id, `mcp:<server>:<tool>`. */
  id: string;
  name: string;
}

export const listAllowedTools = () => request<AllowedTool[]>("/api/heads-down/allowed-tools");

export const setToolAllowed = (id: string, allowed: boolean) =>
  request<{ id: string; allowed: boolean }>(
    `/api/heads-down/allowed-tools/${encodeURIComponent(id)}`,
    "PUT",
    { allowed },
  );

/** Calls the decision model approved on the user's behalf, newest first. */
export const listAutoApprovals = () =>
  request<HeadsDownQuestion[]>("/api/heads-down/auto-approvals");

export const listPasses = () => request<HeadsDownPass[]>("/api/heads-down/passes");

export const getPass = (id: string) =>
  request<{ pass: HeadsDownPass; messages: PassMessage[] }>(`/api/heads-down/passes/${id}`);

export const listHeadsDownMessages = () => request<HeadsDownMessage[]>("/api/heads-down/messages");

export const sendHeadsDownMessage = (body: string) =>
  request<HeadsDownMessage>("/api/heads-down/messages", "POST", { body });

export const listOpenQuestions = () => request<HeadsDownQuestion[]>("/api/heads-down/questions");

export const answerQuestion = (id: string, input: { choice?: string; answer?: string }) =>
  request<HeadsDownQuestion>(`/api/heads-down/questions/${id}/answer`, "POST", input);

export const dismissQuestion = (id: string) =>
  request<{ dismissed: boolean }>(`/api/heads-down/questions/${id}/dismiss`, "POST");

export const listWorkStreams = () => request<WorkStream[]>("/api/work-streams");

export interface WorkStreamPatch {
  status?: WorkStreamStatus;
  priority?: WorkStream["priority"];
  paused?: boolean;
}

export const updateWorkStream = (id: string, patch: WorkStreamPatch) =>
  request<WorkStream>(`/api/work-streams/${id}`, "PATCH", patch);

/** Live updates for the page; forward only, so a reconnect re-reads the lists. */
export async function* streamHeadsDown(signal: AbortSignal): AsyncGenerator<HeadsDownStreamEvent> {
  for await (const data of streamSSE("/api/heads-down/stream", { signal })) {
    try {
      yield JSON.parse(data) as HeadsDownStreamEvent;
    } catch (e) {
      console.warn("[heads-down] dropped unparseable stream frame:", e);
    }
  }
}
