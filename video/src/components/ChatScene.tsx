import type { ReactNode } from "react";
import { doneAt, type ScriptTurn, sentAt } from "../lib/chatScript";
import { ChatView } from "../screens/ChatView";
import { AppScene } from "./AppScene";
import type { Shot } from "./Camera";
import type { CaptionProps } from "./Caption";
import { closeUp, framed, swingIn } from "./shots";

/** Frames a chat scene needs: every turn finished, then a hold to read the last reply. */
export const chatSceneFrames = (turns: ScriptTurn[], hold: number) =>
  doneAt(turns[turns.length - 1]) + hold;

/**
 * A scene that is one scripted conversation on the Chat tab. The camera
 * follows the conversation: the composer while a message is typed, the
 * thread while the reply streams, then the whole window.
 */
export function ChatScene({
  turns,
  caption,
  session,
  overlay,
}: {
  turns: ScriptTurn[];
  caption: CaptionProps;
  session?: string;
  overlay?: ReactNode;
}) {
  const shots: Shot[] = [...swingIn()];
  for (const turn of turns) {
    shots.push(closeUp(turn.typeAt + 4, 560, 690, 1.4, 20));
    // Wide enough that the thread's left edge, where tool calls and replies
    // start, stays clear of the caption fade.
    shots.push(closeUp(sentAt(turn), 620, 470, 1.12));
    shots.push(closeUp(sentAt(turn) + turn.replyAfter + 12, 620, 500, 1.1));
  }
  shots.push(framed(doneAt(turns[turns.length - 1]) + 6));

  return (
    <AppScene tab="chat" shots={shots} caption={caption} overlay={overlay}>
      <ChatView turns={turns} session={session} />
    </AppScene>
  );
}
