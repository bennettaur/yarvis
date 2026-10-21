import { Em } from "../components/Caption";
import { ChatScene, chatSceneFrames } from "../components/ChatScene";
import { type ScriptTurn, sentAt } from "../lib/chatScript";
import { sec } from "../lib/timing";

const TURN: ScriptTurn = {
  typeAt: 34,
  typeCps: 80,
  user: "This week is about shipping the billing migration. PROJ-412 and PROJ-415 are urgent, PROJ-420 is nice to have. I need to review Sam's auth PR before Wednesday, and the flaky checkout test should be fixed by Friday.",
  tools: [
    { name: "upsert_project", after: 8 },
    { name: "track_project_item", after: 18 },
    { name: "track_project_item", after: 24 },
    { name: "track_project_item", after: 30 },
    { name: "create_task", after: 40 },
    { name: "create_todo", after: 50 },
    { name: "remember", after: 60 },
  ],
  replyAfter: 80,
  reply:
    "Got it. **Billing migration** is this week's focus, with PROJ-412 and PROJ-415 urgent and PROJ-420 low.\n\nI added *fix flaky checkout test* as a weekly task due Friday, and I'll remind you about Sam's auth PR before Wednesday.\n\nWant me to start PROJ-412?",
};

export const mondayFrames = (walkthrough: boolean) =>
  chatSceneFrames([TURN], walkthrough ? sec(4) : sec(1.5));

/** Monday: the week's priorities said once, in chat, and turned into a project, tasks and memory. */
export function Monday({ walkthrough = false }: { walkthrough?: boolean }) {
  return (
    <ChatScene
      turns={[TURN]}
      caption={{
        kicker: "Monday · set priorities",
        title: "Start the week by talking, not filling in forms",
        pointsAt: sentAt(TURN) + 10,
        pointStep: walkthrough ? 26 : 30,
        points: walkthrough
          ? [
              <>
                A <Em>project</Em> with a focus for the week
              </>,
              <>
                Each ticket tracked at the <Em>priority</Em> you said
              </>,
              <>
                <Em>Tasks</Em> for your goals, daily or weekly
              </>,
              <>
                A <Em>todo</Em> for what the assistant promised
              </>,
              <>
                The reasons kept in <Em>memory</Em>
              </>,
            ]
          : [<>Projects, priorities and tasks</>, <>All from one message</>],
      }}
    />
  );
}
