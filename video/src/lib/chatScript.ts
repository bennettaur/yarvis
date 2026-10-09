import type { ChatMessageMetadata, ThreadMessage, ToolActivity } from "../../../src/lib/chat";
import { typed, typingFrames } from "./timing";

export interface ScriptTool {
  name: string;
  /** Frames after the message is sent that the call starts. */
  after: number;
  /** Frames the call stays pending before it settles. `Infinity` keeps it pending. */
  pendingFrames?: number;
  status?: ToolActivity["status"];
  durationMs?: number;
  server?: string;
}

export interface ScriptTurn {
  /**
   * Frame the user starts typing this message into the composer. A spoken turn
   * (`metadata.source === "voice"`) skips the composer and is sent at this frame.
   */
  typeAt: number;
  user: string;
  /** Characters per second typed into the composer. */
  typeCps?: number;
  metadata?: ChatMessageMetadata;
  tools?: ScriptTool[];
  /** Frames after the message is sent that the reply starts streaming. */
  replyAfter: number;
  reply: string;
  /** Characters per second the reply streams at. */
  replyCps?: number;
}

export interface ChatFrame {
  messages: ThreadMessage[];
  streaming: string;
  activity: ToolActivity[];
  busy: boolean;
  /** What is in the composer right now. */
  draft: string;
}

const SEND_PAUSE = 8;
const REPLY_CPS = 110;

/** The frame a turn's message leaves the composer. */
export function sentAt(turn: ScriptTurn) {
  if (turn.metadata?.source === "voice") return turn.typeAt;
  return turn.typeAt + typingFrames(turn.user, turn.typeCps) + SEND_PAUSE;
}

/** The frame a turn's reply has finished streaming. */
export function doneAt(turn: ScriptTurn) {
  return sentAt(turn) + turn.replyAfter + typingFrames(turn.reply, turn.replyCps ?? REPLY_CPS);
}

function toolsAt(turn: ScriptTurn, sinceSend: number): ToolActivity[] {
  return (turn.tools ?? [])
    .map((tool, i) => ({ tool, i }))
    .filter(({ tool }) => sinceSend >= tool.after)
    .map(({ tool, i }) => {
      const settled = sinceSend >= tool.after + (tool.pendingFrames ?? 10);
      return {
        id: `${turn.typeAt}-${i}`,
        name: tool.name,
        server: tool.server,
        status: settled ? (tool.status ?? "ok") : "pending",
        // Unless the script gives one, a made-up duration that varies by row but
        // is the same on every frame.
        durationMs: settled ? (tool.durationMs ?? 140 + ((i * 97) % 600)) : undefined,
      };
    });
}

/** Streams in whole words, so half-typed markdown markers don't flash on screen. */
function streamedText(reply: string, chars: number) {
  if (chars >= reply.length) return reply;
  const cut = reply.lastIndexOf(" ", chars);
  if (cut <= 0) return "";
  let text = reply.slice(0, cut);
  // Close an emphasis the cut left open, so it renders bold rather than as asterisks.
  if ((text.match(/\*\*/g) ?? []).length % 2 === 1) text += "**";
  else if ((text.replace(/\*\*/g, "").match(/\*/g) ?? []).length % 2 === 1) text += "*";
  return text;
}

/**
 * The props `ChatMessages` would be holding at `frame` if the scripted
 * conversation were happening live: typed drafts, tool calls landing, the
 * reply streaming, then the finished turn folding into the thread.
 */
export function chatAt(turns: ScriptTurn[], frame: number): ChatFrame {
  const messages: ThreadMessage[] = [];
  let streaming = "";
  let activity: ToolActivity[] = [];
  let busy = false;
  let draft = "";

  for (const turn of turns) {
    if (frame < turn.typeAt) break;
    const sent = sentAt(turn);
    if (frame < sent) {
      draft = typed(turn.user, frame, turn.typeAt, turn.typeCps);
      break;
    }
    messages.push({
      id: `u-${turn.typeAt}`,
      role: "user",
      content: turn.user,
      metadata: turn.metadata,
    });
    const sinceSend = frame - sent;
    if (frame >= doneAt(turn)) {
      messages.push({ role: "assistant", content: turn.reply, activity: toolsAt(turn, Infinity) });
      continue;
    }
    busy = true;
    activity = toolsAt(turn, sinceSend);
    if (sinceSend >= turn.replyAfter) {
      const sofar = typed(turn.reply, sinceSend, turn.replyAfter, turn.replyCps ?? REPLY_CPS);
      streaming = streamedText(turn.reply, sofar.length);
    }
    break;
  }

  return { messages, streaming, activity, busy, draft };
}
