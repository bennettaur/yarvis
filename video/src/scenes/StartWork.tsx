import { useCurrentFrame } from "remotion";
import { AppScene } from "../components/AppScene";
import { Em } from "../components/Caption";
import { closeUp, framed, swingIn } from "../components/shots";
import { claudeWelcome, type TermLine } from "../components/Terminal";
import { doneAt, type ScriptTurn, sentAt } from "../lib/chatScript";
import { enter, sec } from "../lib/timing";
import { ChatView } from "../screens/ChatView";
import { ChangedFiles, pr, type WorkspaceGroup, WorkspacesView } from "../screens/WorkspacesView";

const TURN: ScriptTurn = {
  typeAt: 26,
  typeCps: 34,
  user: "Start work on PROJ-412 in billing-api.",
  tools: [{ name: "jira_start_work_on_issue", at: 6, runs: 30, durationMs: 4200 }],
  replyAt: 40,
  reply:
    "Started **proj-412-ledger-backfill**. The session is reading the ticket now. I assigned PROJ-412 to you and moved it to In Progress.",
};

const SWITCH = doneAt(TURN) + 20;
const READY = SWITCH + 46;
const CLAUDE = READY + 10;

const SETUP: TermLine[] = [
  {
    at: SWITCH + 4,
    text: "yarvis ▸ worktree billing-api → proj-412-ledger-backfill",
    tone: "text-zinc-500",
  },
  { at: SWITCH + 12, text: "yarvis ▸ bin/setup  ✓ 14.2s", tone: "text-zinc-500" },
  {
    at: SWITCH + 20,
    text: "yarvis ▸ AGENTS.md, hooks, skills, .mcp.json  ✓",
    tone: "text-zinc-500",
  },
  { at: SWITCH + 28, text: "yarvis ▸ .yarvis/brief.md ← PROJ-412", tone: "text-zinc-500" },
  { at: SWITCH + 36, text: " " },
];

const SESSION: TermLine[] = [
  ...claudeWelcome(CLAUDE, "~/workspaces/proj-412-ledger-backfill"),
  {
    at: CLAUDE + 6,
    text: "> Read .yarvis/brief.md and make a first pass at the ticket.",
    type: true,
    cps: 70,
  },
  { at: CLAUDE + 40, text: " " },
  { at: CLAUDE + 44, text: "⏺ Read(.yarvis/brief.md)", tone: "text-zinc-100" },
  { at: CLAUDE + 52, text: "  ⎿  Read 38 lines", tone: "text-zinc-500" },
  {
    at: CLAUDE + 64,
    text: '⏺ Search(pattern: "ledger_entries", path: "app/")',
    tone: "text-zinc-100",
  },
  { at: CLAUDE + 72, text: "  ⎿  Found 9 files", tone: "text-zinc-500" },
  {
    at: CLAUDE + 86,
    text: "⏺ The backfill needs a batched job over ledger_entries. I'll",
    tone: "text-zinc-100",
  },
  {
    at: CLAUDE + 86,
    text: "  start with a dry-run flag so it can be checked safely.",
    tone: "text-zinc-100",
  },
];

const groups = (ready: boolean): WorkspaceGroup[] => [
  {
    label: "billing-api",
    rows: [
      { name: "proj-412-ledger-backfill", status: ready ? "active" : "creating" },
      { name: "proj-415-webhook-retries", status: "active", prs: pr(234, "pending") },
    ],
  },
  {
    label: "web-checkout",
    rows: [
      {
        name: "fix-flaky-checkout-test",
        status: "active",
        prs: pr(229, "success", { reviewDecision: "approved" }),
      },
    ],
  },
];

export const startWorkFrames = (full: boolean) => CLAUDE + (full ? sec(6.5) : sec(4.2));

/** One sentence in chat becomes a workspace, a worktree, and a Claude Code session on the ticket. */
export function StartWork({ full = false }: { full?: boolean }) {
  const frame = useCurrentFrame();
  const inWorkspaces = frame >= SWITCH;
  const ready = frame >= READY;

  return (
    <AppScene
      tab={inWorkspaces ? "workspaces" : "chat"}
      shots={[
        ...swingIn(),
        closeUp(sentAt(TURN) - 4, 620, 560, 1.12),
        framed(SWITCH - 6, 16),
        closeUp(SWITCH + 8, 520, 420, 1.35),
        closeUp(CLAUDE + 30, 520, 470, 1.5),
      ]}
      caption={{
        kicker: "Start work",
        title: "One sentence to a running agent on the ticket",
        pointsAt: SWITCH + 4,
        pointStep: full ? 22 : 40,
        points: full
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
        <div className="h-full" style={enter(frame, SWITCH, 10, 0)}>
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
              spinnerFrom: CLAUDE + 100,
              spinnerLabel: "Reading the ledger models…",
              side: (
                <ChangedFiles
                  files={
                    frame >= CLAUDE + 100
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
