import { useCurrentFrame } from "remotion";
import { AppScene } from "../components/AppScene";
import { Em } from "../components/Caption";
import { closeUp, framed, swingIn } from "../components/shots";
import { claudeWelcome, type TermLine } from "../components/Terminal";
import { doneAt, type ScriptTurn, sentAt } from "../lib/chatScript";
import { enter, sec } from "../lib/timing";
import { ChatView } from "../screens/ChatView";
import {
  ChangedFiles,
  prSummary,
  type WorkspaceGroup,
  WorkspacesView,
} from "../screens/WorkspacesView";

const TURN: ScriptTurn = {
  typeAt: 26,
  typeCps: 34,
  user: "Start work on PROJ-412 in billing-api.",
  tools: [{ name: "jira_start_work_on_issue", after: 6, pendingFrames: 30, durationMs: 4200 }],
  replyAfter: 40,
  reply:
    "Started **proj-412-ledger-backfill**. The session is reading the ticket now. I assigned PROJ-412 to you and moved it to In Progress.",
};

// Frames the view cuts to Workspaces, the worktree is ready, and Claude Code starts.
const SWITCH_AT = doneAt(TURN) + 20;
const READY_AT = SWITCH_AT + 46;
const CLAUDE_AT = READY_AT + 10;

const SETUP: TermLine[] = [
  {
    at: SWITCH_AT + 4,
    text: "yarvis ▸ worktree billing-api → proj-412-ledger-backfill",
    colorClass: "text-zinc-500",
  },
  { at: SWITCH_AT + 12, text: "yarvis ▸ bin/setup  ✓ 14.2s", colorClass: "text-zinc-500" },
  {
    at: SWITCH_AT + 20,
    text: "yarvis ▸ AGENTS.md, hooks, skills, .mcp.json  ✓",
    colorClass: "text-zinc-500",
  },
  { at: SWITCH_AT + 28, text: "yarvis ▸ .yarvis/brief.md ← PROJ-412", colorClass: "text-zinc-500" },
  { at: SWITCH_AT + 36, text: " " },
];

const SESSION: TermLine[] = [
  ...claudeWelcome(CLAUDE_AT, "~/workspaces/proj-412-ledger-backfill"),
  {
    at: CLAUDE_AT + 6,
    text: "> Read .yarvis/brief.md and make a first pass at the ticket.",
    typeOut: true,
    cps: 70,
  },
  { at: CLAUDE_AT + 40, text: " " },
  { at: CLAUDE_AT + 44, text: "⏺ Read(.yarvis/brief.md)", colorClass: "text-zinc-100" },
  { at: CLAUDE_AT + 52, text: "  ⎿  Read 38 lines", colorClass: "text-zinc-500" },
  {
    at: CLAUDE_AT + 64,
    text: '⏺ Search(pattern: "ledger_entries", path: "app/")',
    colorClass: "text-zinc-100",
  },
  { at: CLAUDE_AT + 72, text: "  ⎿  Found 9 files", colorClass: "text-zinc-500" },
  {
    at: CLAUDE_AT + 86,
    text: "⏺ The backfill needs a batched job over ledger_entries. I'll",
    colorClass: "text-zinc-100",
  },
  {
    at: CLAUDE_AT + 86,
    text: "  start with a dry-run flag so it can be checked safely.",
    colorClass: "text-zinc-100",
  },
];

const groups = (ready: boolean): WorkspaceGroup[] => [
  {
    label: "billing-api",
    rows: [
      { name: "proj-412-ledger-backfill", status: ready ? "active" : "creating" },
      { name: "proj-415-webhook-retries", status: "active", pr: prSummary(234, "pending") },
    ],
  },
  {
    label: "web-checkout",
    rows: [
      {
        name: "fix-flaky-checkout-test",
        status: "active",
        pr: prSummary(229, "success", { reviewDecision: "approved" }),
      },
    ],
  },
];

export const startWorkFrames = (walkthrough: boolean) =>
  CLAUDE_AT + (walkthrough ? sec(6.5) : sec(4.2));

/** One sentence in chat becomes a workspace, a worktree, and a Claude Code session on the ticket. */
export function StartWork({ walkthrough = false }: { walkthrough?: boolean }) {
  const frame = useCurrentFrame();
  const inWorkspaces = frame >= SWITCH_AT;
  const ready = frame >= READY_AT;

  return (
    <AppScene
      tab={inWorkspaces ? "workspaces" : "chat"}
      shots={[
        ...swingIn(),
        closeUp(sentAt(TURN) - 4, 620, 560, 1.12),
        framed(SWITCH_AT - 6, 16),
        closeUp(SWITCH_AT + 8, 520, 420, 1.35),
        closeUp(CLAUDE_AT + 30, 520, 470, 1.5),
      ]}
      caption={{
        kicker: "Start work",
        title: "One sentence to a running agent on the ticket",
        pointsAt: SWITCH_AT + 4,
        pointStep: walkthrough ? 22 : 40,
        points: walkthrough
          ? [
              <>
                A <Em>workspace</Em> with a git worktree per repo
              </>,
              <>
                The repo's <Em>setup script</Em> runs
              </>,
              <>
                <Em>AGENTS.md</Em>, hooks, skills and Yarvis memory over MCP
              </>,
              <>
                The ticket written to <Em>.yarvis/brief.md</Em>
              </>,
              <>
                A <Em>Claude Code</Em> session told to make a first pass
              </>,
            ]
          : [<>Worktree, setup, context, brief</>, <>Then Claude Code starts on it</>],
      }}
    >
      {inWorkspaces ? (
        <div className="h-full" style={enter(frame, SWITCH_AT, 10, 0)}>
          <WorkspacesView
            groups={groups(ready)}
            selected="proj-412-ledger-backfill"
            detail={{
              name: "proj-412-ledger-backfill",
              status: ready ? "active" : "creating",
              rootPath: "~/workspaces/proj-412-ledger-backfill",
              repos: [{ name: "billing-api", branch: "proj-412-ledger-backfill", ready }],
              tasks: [{ title: "PROJ-412 Ledger backfill", done: false }],
              terminal: [...SETUP, ...SESSION],
              spinnerFrom: CLAUDE_AT + 100,
              spinnerLabel: "Reading the ledger models…",
              side: (
                <ChangedFiles
                  files={
                    frame >= CLAUDE_AT + 100
                      ? [{ path: "app/jobs/ledger_backfill.rb", change: "A", add: 18, del: 0 }]
                      : []
                  }
                />
              ),
            }}
          />
        </div>
      ) : (
        <ChatView turns={[TURN]} />
      )}
    </AppScene>
  );
}
