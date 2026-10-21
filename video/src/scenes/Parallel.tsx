import { useCurrentFrame } from "remotion";
import ReviewCommentCard from "../../../src/components/workspaces/ReviewCommentCard";
import { AppScene } from "../components/AppScene";
import { Em } from "../components/Caption";
import { closeUp, framed, swingIn } from "../components/shots";
import type { TermLine } from "../components/Terminal";
import { noop } from "../lib/style";
import { progress, sec } from "../lib/timing";
import { AttentionPanel } from "../screens/AttentionPanel";
import {
  ChangedFiles,
  PrStatusLine,
  prSummary,
  type WorkspaceGroup,
  WorkspacesView,
} from "../screens/WorkspacesView";

// Frames proj-412's session goes idle, #229 becomes ready to merge, the
// walkthrough opens the Comments tab, and the attention panel opens.
const IDLE_412_AT = 50;
const READY_229_AT = 80;
const COMMENTS_AT = 110;
const PANEL_AT = 166;

// Relative to the render's own clock: `ReviewCommentCard` labels the time
// against `Date.now()`, so a fixed date would read "N days ago".
const COMMENT_TIME = new Date(Date.now() - 5 * 60_000).toISOString();

const groups = (frame: number): WorkspaceGroup[] => [
  {
    label: "billing-api",
    rows: [
      {
        name: "proj-412-ledger-backfill",
        status: "active",
        pr: prSummary(231, frame >= IDLE_412_AT ? "success" : "pending"),
        attention: frame >= IDLE_412_AT,
      },
      {
        name: "proj-415-webhook-retries",
        status: "active",
        pr: prSummary(234, "failure"),
        attention: true,
      },
      {
        name: "proj-420-export-csv",
        status: "active",
        pr: prSummary(236, "none", { isDraft: true }),
      },
    ],
  },
  {
    label: "web-checkout",
    rows: [
      {
        name: "fix-flaky-checkout-test",
        status: "active",
        pr: prSummary(229, frame >= READY_229_AT ? "success" : "pending", {
          reviewDecision: "approved",
        }),
      },
    ],
  },
  {
    label: "auth-service",
    rows: [
      {
        name: "auth-session-refresh",
        status: "active",
        pr: prSummary(218, "success", { reviewDecision: "changes_requested" }),
      },
    ],
  },
];

const TERMINAL: TermLine[] = [
  { at: 0, text: "⏺ Update(app/webhooks/retry.rb)", colorClass: "text-zinc-100" },
  { at: 0, text: "  ⎿  Updated with 14 additions and 3 removals", colorClass: "text-zinc-500" },
  { at: 0, text: " " },
  { at: 0, text: "⏺ Bash(bundle exec rspec spec/webhooks)", colorClass: "text-zinc-100" },
  { at: 0, text: " " },
  {
    at: 0,
    text: "╭────────────────────────────────────────────────────╮",
    colorClass: "text-amber-300",
  },
  {
    at: 0,
    text: "│ Bash command                                       │",
    colorClass: "text-amber-300",
  },
  {
    at: 0,
    text: "│   bundle exec rspec spec/webhooks                  │",
    colorClass: "text-amber-300",
  },
  {
    at: 0,
    text: "│ Do you want to proceed?                            │",
    colorClass: "text-amber-300",
  },
  {
    at: 0,
    text: "│ > 1. Yes                                           │",
    colorClass: "text-amber-300",
  },
  {
    at: 0,
    text: "│   2. No, and tell Claude what to do differently    │",
    colorClass: "text-amber-300",
  },
  {
    at: 0,
    text: "╰────────────────────────────────────────────────────╯",
    colorClass: "text-amber-300",
  },
];

export const parallelFrames = (walkthrough: boolean) => (walkthrough ? sec(14) : sec(10));

/** Five workspaces at once: PR badges change, the bell collects whoever is blocked on you. */
export function Parallel({ walkthrough = false }: { walkthrough?: boolean }) {
  const frame = useCurrentFrame();
  const panelAt = walkthrough ? PANEL_AT + 90 : PANEL_AT;
  const slide = progress(frame, panelAt, 16);
  const attention = frame >= IDLE_412_AT ? 2 : 1;

  return (
    <AppScene
      tab="workspaces"
      attention={attention}
      shots={[
        ...swingIn(),
        closeUp(IDLE_412_AT - 14, 170, 260, 1.55),
        ...(walkthrough ? [closeUp(COMMENTS_AT, 1030, 380, 1.5)] : []),
        framed(panelAt - 16, 18),
        closeUp(panelAt + 14, 990, 300, 1.35),
      ]}
      cursor={[
        { at: panelAt - 24, x: 900, y: 500 },
        { at: panelAt - 18, x: 1105, y: 54, dur: 16, click: true },
      ]}
      caption={{
        kicker: "Workspaces",
        title: "Many agents in parallel. One glance says who needs you.",
        pointsAt: 40,
        pointStep: walkthrough ? 50 : 40,
        points: walkthrough
          ? [
              <>
                A badge per PR: <span style={{ color: "#f87171" }}>✗</span> failing,{" "}
                <span style={{ color: "#fbbf24" }}>●</span> running,{" "}
                <span style={{ color: "#6ee7b7" }}>★</span> ready to merge
              </>,
              <>
                <Em>Self-review</Em> comments, then <Em>Copy for Claude</Em>
              </>,
              <>
                The <Em>bell</Em> collects every blocked or idle session
              </>,
              <>Sessions keep running while you're elsewhere</>,
            ]
          : [
              <>Live PR and CI state</>,
              <>
                The <Em>bell</Em> collects blocked sessions
              </>,
            ],
      }}
      overlay={
        <AttentionPanel
          slide={slide}
          rows={[
            {
              kind: "permission",
              title: "proj-415-webhook-retries",
              tabs: "Claude",
              body: "Claude needs your permission to use Bash",
              when: "2 minutes ago",
            },
            {
              kind: "idle",
              title: "proj-412-ledger-backfill",
              tabs: "Claude",
              body: "Claude is waiting for your input",
              when: "just now",
            },
          ]}
          wip={[
            {
              kind: "PR",
              title: "Refresh sessions before expiry",
              subtitle: "auth-service #218 · review requested",
            },
            { kind: "Task", title: "Fix flaky checkout test", subtitle: "weekly · due Friday" },
          ]}
        />
      }
    >
      <WorkspacesView
        groups={groups(frame)}
        selected="proj-415-webhook-retries"
        detail={{
          name: "proj-415-webhook-retries",
          status: "active",
          rootPath: "~/workspaces/proj-415-webhook-retries",
          repos: [{ name: "billing-api", branch: "proj-415-webhook-retries", ready: true }],
          prLine: <PrStatusLine number={234} rollup="failure" />,
          terminal: TERMINAL,
          agentFlagged: true,
          sideTab: walkthrough && frame >= COMMENTS_AT ? "Comments" : "Changed",
          commentCount: 1,
          side:
            walkthrough && frame >= COMMENTS_AT ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-zinc-500">
                  1 open · 0 resolved
                  <span className="ml-auto rounded border border-zinc-700 px-2 py-0.5">
                    Copy for Claude
                  </span>
                </div>
                <ReviewCommentCard
                  comment={{
                    id: "c1",
                    workspaceRepoId: "r1",
                    path: "app/webhooks/retry.rb",
                    startLine: 41,
                    endLine: 44,
                    commitSha: null,
                    body: "Back off with jitter here, or every retry lands on the same second.",
                    resolvedAt: null,
                    createdAt: COMMENT_TIME,
                    updatedAt: COMMENT_TIME,
                  }}
                  location="retry.rb:41–44"
                  onToggleResolved={noop}
                  onDelete={noop}
                />
              </div>
            ) : (
              <ChangedFiles
                files={[
                  { path: "app/webhooks/retry.rb", change: "M", add: 14, del: 3 },
                  { path: "spec/webhooks/retry_spec.rb", change: "M", add: 22, del: 0 },
                ]}
              />
            ),
        }}
      />
    </AppScene>
  );
}
