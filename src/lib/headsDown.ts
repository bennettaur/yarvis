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
  /** MCP tools a pass may call without asking, by registry id (`mcp:<server>:<tool>`). */
  unattendedMcpTools: string[];
  provider: string | null;
  model: string | null;
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
  | { type: "error"; message: string }
  | { type: "done"; text: string }
  | { type: "attention"; reason?: string };

export type HeadsDownStreamEvent =
  | { type: "pass-started"; passId: string }
  | { type: "pass-event"; passId: string; event: PassEvent }
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

export const startHeadsDown = (focus: string) =>
  request<HeadsDownRun>("/api/heads-down/start", "POST", { focus });

export const stopHeadsDown = () => request<{ stopped: boolean }>("/api/heads-down/stop", "POST");

export const getHeadsDownConfig = () => request<HeadsDownConfig>("/api/heads-down/config");

export const saveHeadsDownConfig = (config: HeadsDownConfig) =>
  request<HeadsDownConfig>("/api/heads-down/config", "PUT", config);

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

export const updateWorkStream = (
  id: string,
  patch: { status?: WorkStreamStatus; priority?: WorkStream["priority"] },
) => request<WorkStream>(`/api/work-streams/${id}`, "PATCH", patch);

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
