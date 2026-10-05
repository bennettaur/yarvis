import type { ReactNode } from "react";
import { useCurrentFrame } from "remotion";
import ChatComposer from "../../../src/components/ChatComposer";
import ChatMessages from "../../../src/components/ChatMessages";
import { Column, Row } from "../../../src/omni/primitives";
import WidgetFrame from "../../../src/omni/WidgetFrame";
import { AppScene } from "../components/AppScene";
import { Em } from "../components/Caption";
import { closeUp, framed, swingIn } from "../components/shots";
import { chatAt, doneAt, type ScriptTurn, sentAt } from "../lib/chatScript";
import { noop } from "../lib/style";
import { caretOn, enter, pop, progress, sec, typed, typingFrames, withCaret } from "../lib/timing";
import { DiffFile, PrReviewView } from "../screens/PrReviewView";

/** Frame Omni Chat is summoned. */
const SUMMON_AT = 40;

const TURN: ScriptTurn = {
  typeAt: SUMMON_AT + 24,
  typeCps: 30,
  user: "What's risky here?",
  replyAfter: 30,
  reply:
    "Two things in **#218**:\n\n1. `refresh()` swallows errors, so a failed refresh leaves the user on an expired token with no retry scheduled.\n2. `scheduleRefresh` uses `Date.now()` directly, so the test for the one-minute lead depends on the wall clock.",
};

const PATCH = [
  "@@ -52,8 +52,8 @@ export class SessionStore {",
  "+  private async refresh() {",
  "+    try {",
  "+      const next = await this.tokens.refresh(this.current.refreshToken);",
  "+      this.start(next);",
  "+    } catch {",
  "+      // Try again on the next request.",
  "+    }",
  "+  }",
].join("\n");

/** Omni Chat over whatever is on screen, from `OmniChat`'s markup. */
function OmniChatOverlay() {
  const frame = useCurrentFrame();
  if (frame < SUMMON_AT) return null;
  const chat = chatAt([TURN], frame);
  const t = pop(frame, SUMMON_AT, 15);
  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center"
      style={{ paddingTop: 110 }}
    >
      <div className="absolute inset-0 bg-black/40" style={{ opacity: Math.min(1, t) }} />
      <div
        className="relative z-10 flex w-[760px] flex-col gap-3 border border-zinc-700 bg-zinc-900 p-4 text-zinc-100 shadow-2xl"
        style={{
          transform: `translateY(${(1 - t) * -30}px) scale(${0.94 + 0.06 * t})`,
          opacity: Math.min(1, t * 1.5),
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-300">Omni Chat</span>
          <span className="rounded-md border border-zinc-700 px-2 py-1 text-xs">New chat</span>
          <div className="ml-auto flex items-center gap-2">
            <span className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-xs">
              Anthropic ▾
            </span>
            <span className="rounded-md border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-xs">
              claude-sonnet-5 ▾
            </span>
          </div>
        </div>
        <div className="flex min-h-[280px] flex-col justify-end space-y-3 overflow-hidden border border-zinc-800 bg-zinc-950/50 p-3">
          <div className="space-y-3">
            <ChatMessages
              messages={chat.messages}
              streaming={chat.streaming}
              busy={chat.busy}
              activity={chat.activity}
              emptyHint="Ask about whatever you're looking at — it's sent along as context."
            />
          </div>
        </div>
        <ChatComposer
          value={withCaret(chat.draft, frame)}
          onChange={noop}
          onSubmit={noop}
          placeholder="Ask anything about what you're looking at…"
          submitLabel="Send"
          textareaClassName="min-h-24"
        />
        <p className="text-right text-xs text-zinc-600">
          Esc to hide · keeps running in the background
        </p>
      </div>
    </div>
  );
}

export const omniChatFrames = () => doneAt(TURN) + sec(3);

/** Omni Chat summoned over a PR: it already knows which PR, so the question needs no pasting. */
export function OmniChat() {
  return (
    <AppScene
      tab="prs"
      shots={[
        ...swingIn(),
        closeUp(SUMMON_AT + 10, 600, 360, 1.3),
        closeUp(sentAt(TURN) + 20, 600, 300, 1.4),
        framed(doneAt(TURN)),
      ]}
      caption={{
        kicker: "Omni Chat · ⌃⇧Space",
        title: "The assistant over any screen",
        pointsAt: SUMMON_AT + 10,
        pointStep: 50,
        points: [
          <>Summon it from anywhere, even with Yarvis in the background</>,
          <>
            It knows the <Em>PR, issue or calendar</Em> you're looking at
          </>,
          <>
            Esc hides it and the reply <Em>keeps streaming</Em>
          </>,
        ],
      }}
      overlay={<OmniChatOverlay />}
    >
      <PrReviewView
        title="Refresh sessions before expiry"
        number={218}
        repo="acme/auth-service · sam"
        files={[
          { path: "src/auth/session.ts", change: "M", add: 18, del: 2 },
          { path: "src/auth/session.test.ts", change: "A", add: 64, del: 0 },
        ]}
        viewed={0}
        selected="src/auth/session.ts"
        guide={null}
      >
        <DiffFile path="src/auth/session.ts" patch={PATCH} add={8} del={0} />
      </PrReviewView>
    </AppScene>
  );
}

const PROMPT = "Today's calendar on the left, my tasks and open PRs on the right.";
const PROMPT_AT = 30;
const PROMPT_CPS = 40;
// Frames the prompt is sent, and the layout appears.
const BUILD_AT = PROMPT_AT + typingFrames(PROMPT, PROMPT_CPS) + 10;
const BUILT_AT = BUILD_AT + 30;

/** One widget landing in the generated layout. */
function Widget({
  at,
  title,
  name,
  children,
}: {
  at: number;
  title: string;
  name: string;
  children: ReactNode;
}) {
  const frame = useCurrentFrame();
  const t = pop(frame, at, 13);
  return (
    <div
      className="h-full min-w-0 flex-1"
      style={{ opacity: Math.min(1, t * 1.4), transform: `scale(${0.9 + 0.1 * t})` }}
    >
      <WidgetFrame title={title} name={name}>
        {children}
      </WidgetFrame>
    </div>
  );
}

const Item = ({ children, meta }: { children: ReactNode; meta?: ReactNode }) => (
  <div className="flex items-center gap-2 border-b border-zinc-800/60 px-2 py-2 text-sm text-zinc-200">
    <span className="min-w-0 flex-1 truncate">{children}</span>
    {meta}
  </div>
);

/** The Omni view, from `OmniView`'s markup: a layout described in words, built from live widgets. */
function OmniViewScreen() {
  const frame = useCurrentFrame();
  const built = frame >= BUILT_AT;
  return (
    <div className="flex h-full min-h-0">
      <div className="flex h-full min-w-0 flex-[0.72] flex-col overflow-hidden">
        <div
          className={`h-0.5 shrink-0 ${frame >= BUILD_AT && !built ? "bg-indigo-500" : "bg-transparent"}`}
          style={{ opacity: frame >= BUILD_AT && !built ? 0.5 + 0.5 * Math.sin(frame / 3) : 1 }}
        />
        <div className="min-h-0 flex-1 overflow-hidden p-1">
          {built ? (
            <Row>
              <Widget at={BUILT_AT} title="Calendar" name="Calendar">
                {[
                  ["9:30", "Standup"],
                  ["2:00", "Billing sync"],
                  ["3:30", "1:1 with Priya"],
                  ["4:15", "Auth design review"],
                ].map(([time, title]) => (
                  <Item key={title} meta={<span className="text-xs text-zinc-500">{time}</span>}>
                    {title}
                  </Item>
                ))}
              </Widget>
              <Column>
                <Widget at={BUILT_AT + 10} title="Tasks" name="Tasks">
                  <Item
                    meta={
                      <span className="rounded bg-indigo-900/40 px-1.5 py-0.5 text-xs text-indigo-200">
                        Today
                      </span>
                    }
                  >
                    Review Sam's auth PR
                  </Item>
                  <Item
                    meta={
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                        Friday
                      </span>
                    }
                  >
                    Fix flaky checkout test
                  </Item>
                </Widget>
                <Widget at={BUILT_AT + 20} title="Pull Requests" name="PrList">
                  <Item
                    meta={
                      <span className="rounded bg-red-900 px-1.5 py-0.5 text-xs text-red-200">
                        CI failing
                      </span>
                    }
                  >
                    Webhook retries #234
                  </Item>
                  <Item
                    meta={
                      <span className="rounded bg-emerald-900 px-1.5 py-0.5 text-xs text-emerald-200">
                        CI passing
                      </span>
                    }
                  >
                    Ledger backfill #231
                  </Item>
                  <Item
                    meta={
                      <span className="rounded bg-amber-900 px-1.5 py-0.5 text-xs text-amber-200">
                        CI running
                      </span>
                    }
                  >
                    CSV export #236
                  </Item>
                </Widget>
              </Column>
            </Row>
          ) : frame >= BUILD_AT ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-zinc-400">
              Generating your layout…
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
              <div>
                <h2 className="text-lg font-semibold text-zinc-200">Omni</h2>
                <p className="mt-1 max-w-md text-sm text-zinc-500">
                  Ask the chat to build a view from your widgets — tasks, calendar, PRs, memory,
                  sessions, alarms, and chat windows — in any layout.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="w-px bg-zinc-800" />
      <aside className="flex h-full min-w-0 flex-[0.28] flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-2">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">Builder</span>
          <span className="text-xs text-zinc-500">Clear</span>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-hidden px-4 py-4">
          {frame >= BUILD_AT && (
            <div className="text-sm" style={enter(frame, BUILD_AT)}>
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">user</div>
              <div className="whitespace-pre-wrap text-zinc-100">{PROMPT}</div>
            </div>
          )}
          {built && (
            <div className="text-sm" style={enter(frame, BUILT_AT)}>
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">assistant</div>
              <div className="whitespace-pre-wrap text-zinc-100">
                Built a calendar beside your tasks and open PRs.
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-2 border-t border-zinc-800 p-3">
          <div className="min-h-9 flex-1 border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100">
            {frame < BUILD_AT ? typed(PROMPT, frame, PROMPT_AT, PROMPT_CPS) : ""}
            {frame < BUILD_AT && frame >= PROMPT_AT && caretOn(frame) && "▏"}
            {(frame < PROMPT_AT || frame >= BUILD_AT) && (
              <span className="text-zinc-500">Describe a layout...</span>
            )}
          </div>
          <span
            className="h-fit self-end rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium"
            style={{ opacity: 1 - 0.4 * progress(frame, BUILD_AT, 4) }}
          >
            Build
          </span>
        </div>
      </aside>
    </div>
  );
}

export const omniViewFrames = () => BUILD_AT + sec(5);

/** A dashboard described in one sentence, assembled from the app's own widgets. */
export function OmniView() {
  return (
    <AppScene
      tab="omni"
      shots={[
        ...swingIn(),
        closeUp(26, 1000, 600, 1.5),
        framed(BUILD_AT + 6),
        closeUp(BUILT_AT + 30, 450, 380, 1.2),
      ]}
      caption={{
        kicker: "Omni view",
        title: "A dashboard you describe",
        pointsAt: BUILD_AT + 20,
        pointStep: 36,
        points: [
          <>Live widgets: tasks, calendar, PRs, diffs, terminals, chat</>,
          <>
            <Em>Save it as a layout</Em> and load it every morning
          </>,
        ],
      }}
    >
      <OmniViewScreen />
    </AppScene>
  );
}
