import { useCurrentFrame } from "remotion";
import { Em } from "../components/Caption";
import { ChatScene, chatSceneFrames } from "../components/ChatScene";
import { doneAt, type ScriptTurn, sentAt } from "../lib/chatScript";
import { pop, progress, sec } from "../lib/timing";

const LEFT_OFF: ScriptTurn[] = [
  {
    typeAt: 30,
    typeCps: 30,
    user: "Morning. Where did we leave off?",
    tools: [
      { name: "recall", after: 6 },
      { name: "search_events", after: 16 },
      { name: "list_todos", after: 26 },
      { name: "list_tasks", after: 34 },
    ],
    replyAfter: 56,
    reply:
      "Yesterday you:\n\n- got PROJ-412's backfill passing locally. The session noted the migration still needs a dry-run flag.\n- reviewed two of Sam's files, and stopped at `session.ts`.\n\nStill open: PROJ-415's failing webhook test, and my reminder to finish Sam's review, which is **due today**.",
  },
];

export const leftOffFrames = (walkthrough: boolean) =>
  chatSceneFrames(LEFT_OFF, walkthrough ? sec(4.5) : sec(2));

/** Wednesday morning: the assistant rebuilds yesterday from summaries, the activity log and its todos. */
export function LeftOff({ walkthrough = false }: { walkthrough?: boolean }) {
  return (
    <ChatScene
      turns={LEFT_OFF}
      session="Wednesday 9:05"
      caption={{
        kicker: "During the week",
        title: "“Where did we leave off?”",
        pointsAt: sentAt(LEFT_OFF[0]) + 4,
        pointStep: walkthrough ? 22 : 34,
        points: walkthrough
          ? [
              <>
                <Em>Day summaries</Em> written overnight
              </>,
              <>
                <Em>Session summaries</Em> of Claude Code transcripts
              </>,
              <>
                The <Em>activity log</Em> since then
              </>,
              <>
                Notes sessions saved to <Em>Yarvis memory</Em> over MCP
              </>,
              <>
                Its own <Em>todos</Em>, and your open <Em>tasks</Em>
              </>,
            ]
          : [<>Day and session summaries</>, <>The activity log, todos and tasks</>],
      }}
    />
  );
}

const PLAN_ASK: ScriptTurn = {
  typeAt: 30,
  typeCps: 32,
  user: "Give me a plan for this afternoon.",
  tools: [{ name: "delegate", after: 6, pendingFrames: 50, server: "planner", durationMs: 8400 }],
  replyAfter: 64,
  reply:
    "1. **Finish Sam's auth review.** It's due today, and you've done only one review this week. Start at `session.ts`.\n2. **Unblock PROJ-415.** It's urgent and CI is red. Ask its session to look at the webhook retry test.\n3. **Merge the flaky-test fix.** It's approved and clean, so it's a two-minute win.",
};

const PLAN_DISMISS: ScriptTurn = {
  typeAt: doneAt(PLAN_ASK) + 30,
  typeCps: 34,
  user: "Not the merge, Priya wants to look first.",
  tools: [{ name: "dismiss_suggestion", after: 6 }],
  replyAfter: 24,
  reply: "Dropped it. I won't suggest merging #229 for the next two days.",
};

const PLAN = [PLAN_ASK, PLAN_DISMISS];

export const planFrames = () => chatSceneFrames(PLAN, sec(3));

/** "What next?" goes to the planner specialist, and a "no" is remembered as a dismissal. */
export function Plan() {
  return (
    <ChatScene
      turns={PLAN}
      caption={{
        kicker: "During the week",
        title: "“What should I work on next?”",
        pointsAt: sentAt(PLAN_ASK) + 10,
        pointStep: 40,
        points: [
          <>
            Ranks what's <Em>waiting on you</Em>: reviews, PRs, tasks
          </>,
          <>
            A plan goes to the <Em>planner</Em>, which reads project priorities
          </>,
          <>
            Saying no records a <Em>dismissal</Em>, so it stops suggesting it
          </>,
        ],
      }}
    />
  );
}

const MERGE_ASK: ScriptTurn = {
  typeAt: 30,
  typeCps: 32,
  user: "Merge main into all my open PRs.",
  tools: [{ name: "sync_workspaces_with_base", after: 6, pendingFrames: 46, durationMs: 11800 }],
  replyAfter: 60,
  reply:
    "- Merged and pushed: proj-412, proj-420, fix-flaky-checkout-test\n- Skipped: auth-session-refresh, which has uncommitted changes\n- **Conflict** in proj-415: `webhooks/retry.rb`. It's left unpushed.\n\nWant the proj-415 session to resolve it?",
};

const MERGE_STEER: ScriptTurn = {
  typeAt: doneAt(MERGE_ASK) + 24,
  typeCps: 20,
  user: "Yes.",
  tools: [{ name: "send_workspace_instruction", after: 6 }],
  replyAfter: 22,
  reply:
    "Sent “resolve the merge conflicts and commit”. It's running in the background. I can confirm it was delivered, not that it's done.",
};

const MERGE = [MERGE_ASK, MERGE_STEER];

export const mergeFrames = (walkthrough: boolean) =>
  chatSceneFrames(MERGE, walkthrough ? sec(4) : sec(2));

/** One message fans out across every workspace, then steers the one that hit a conflict. */
export function MergeMain({ walkthrough = false }: { walkthrough?: boolean }) {
  return (
    <ChatScene
      turns={MERGE}
      caption={{
        kicker: "Steering running work",
        title: "Act on many workspaces with one message",
        pointsAt: sentAt(MERGE_ASK) + 10,
        pointStep: walkthrough ? 34 : 50,
        points: walkthrough
          ? [
              <>
                Fetch, merge base, push, with a <Em>report per workspace</Em>
              </>,
              <>
                Dirty worktrees are <Em>skipped</Em>, not trampled
              </>,
              <>
                Instructions are <Em>typed into the running session</Em>
              </>,
              <>Guarded in code: only when Claude is reading the prompt</>,
            ]
          : [<>A report per workspace</>, <>Then steer the one that needs it</>],
      }}
    />
  );
}

const FRIDAY: ScriptTurn[] = [
  {
    typeAt: 30,
    typeCps: 30,
    user: "What did I get done this week?",
    tools: [{ name: "work_summary", after: 6, pendingFrames: 22 }],
    replyAfter: 36,
    replyCps: 140,
    reply:
      "**Billing migration**: PROJ-412's ledger backfill merged (#231), and PROJ-415's webhook retries are in review (#234, approved, one check pending). PROJ-420 hasn't started.\n\n**Reviews**: 4 given, including Sam's auth refresh (#218, approved after one round).\n\n**Other**: fixed the flaky checkout test (#229, merged). Archived 3 workspaces.",
  },
];

const STATS = [
  { value: 3, label: "PRs merged" },
  { value: 4, label: "reviews given" },
  { value: 12, label: "agent sessions" },
];

const STATS_AT = doneAt(FRIDAY[0]) + 20;

export const fridayFrames = (walkthrough: boolean) => STATS_AT + (walkthrough ? sec(4) : sec(3));

/** Big counters that tick up over the finished summary. */
function WeekStats() {
  const frame = useCurrentFrame();
  if (frame < STATS_AT) return null;
  return (
    <div className="absolute inset-x-0 top-40 z-40 flex justify-center gap-6">
      {STATS.map((stat, i) => {
        const start = STATS_AT + i * 8;
        const n = Math.round(stat.value * progress(frame, start, 24));
        return (
          <div
            key={stat.label}
            className="border border-indigo-500/50 bg-zinc-950/90 px-8 py-4 text-center shadow-2xl"
            style={{
              opacity: progress(frame, start, 12),
              transform: `scale(${0.8 + 0.2 * pop(frame, start)})`,
            }}
          >
            <div className="text-5xl font-bold tracking-tight text-zinc-50">{n}</div>
            <div className="mt-1 text-sm uppercase tracking-widest text-indigo-300">
              {stat.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Friday: one tool call gathers the week, and the reply names every PR. */
export function Friday({ walkthrough = false }: { walkthrough?: boolean }) {
  return (
    <ChatScene
      turns={FRIDAY}
      session="Friday 16:30"
      overlay={<WeekStats />}
      caption={{
        kicker: "Friday · wrap up",
        title: "“What did I get done this week?”",
        pointsAt: sentAt(FRIDAY[0]) + 10,
        pointStep: walkthrough ? 34 : 50,
        points: walkthrough
          ? [
              <>Built from activity, reviews, PRs, tasks and day summaries</>,
              <>
                Good for <Em>status updates</Em>, 1:1s and a <Em>brag doc</Em>
              </>,
              <>Unfinished work is still tracked for Monday</>,
            ]
          : [<>Every PR named</>, <>Ready for a status update</>],
      }}
    />
  );
}
