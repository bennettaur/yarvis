import { useCurrentFrame } from "remotion";
import type { PrGuideStep } from "../../../src/lib/pr/guide";
import { AppScene } from "../components/AppScene";
import { Em } from "../components/Caption";
import { closeUp, framed, swingIn } from "../components/shots";
import { enter, sec, typed } from "../lib/timing";
import { DiffFile, PrReviewView, staticGuide } from "../screens/PrReviewView";

// Joined from lines so blank context rows keep the leading space a patch needs.
const PATCH = [
  "@@ -38,12 +38,28 @@ export class SessionStore {",
  "   constructor(private readonly tokens: TokenClient) {}",
  " ",
  "   start(session: Session) {",
  "     this.current = session;",
  "+    this.scheduleRefresh(session.expiresAt);",
  "   }",
  " ",
  "+  private scheduleRefresh(expiresAt: number) {",
  "+    const lead = 60_000;",
  "+    const delay = Math.max(0, expiresAt - Date.now() - lead);",
  "+    clearTimeout(this.timer);",
  "+    this.timer = setTimeout(() => void this.refresh(), delay);",
  "+  }",
  "+",
  "+  private async refresh() {",
  "+    try {",
  "+      const next = await this.tokens.refresh(this.current.refreshToken);",
  "+      this.start(next);",
  "+    } catch {",
  "+      // Try again on the next request.",
  "+    }",
  "+  }",
  "+",
  "   get token() {",
  "     return this.current.accessToken;",
  "   }",
].join("\n");

const STEPS: PrGuideStep[] = [
  {
    path: "src/http/middleware.ts",
    startLine: 12,
    endLine: 30,
    explanation: "Requests come in here.",
  },
  {
    path: "src/auth/session.ts",
    startLine: 40,
    endLine: 50,
    explanation:
      "Starting a session now schedules its refresh a minute before expiry. Read this before the middleware, which assumes the timer has already run.",
  },
  {
    path: "src/auth/session.ts",
    startLine: 52,
    endLine: 59,
    explanation: "The refresh itself: trade the refresh token for a new session and reschedule.",
    findings: [
      {
        kind: "error-handling",
        path: "src/auth/session.ts",
        startLine: 57,
        note: "A failed refresh is swallowed, so the user stays signed in on an expired token.",
      },
    ],
  },
  // Placeholder steps the scene never reaches, so the counter reads "of 7" like a real tour.
  ...Array.from({ length: 4 }, (_, i) => ({
    path: "src/auth/session.test.ts",
    startLine: null,
    endLine: null,
    explanation: `Step ${i + 4}`,
  })),
];

// Frames the cursor clicks Next, and the line question is asked.
const NEXT_AT = 120;
const ASK_AT = 200;

const FILES = [
  { path: "src/http/middleware.ts", change: "M" as const, add: 6, del: 2 },
  { path: "src/auth/session.ts", change: "M" as const, add: 18, del: 2 },
  { path: "src/auth/tokens.ts", change: "M" as const, add: 4, del: 1 },
  { path: "src/auth/session.test.ts", change: "A" as const, add: 64, del: 0 },
];

const QUESTION = "What happens to the user if refresh() throws?";

export const prReviewFrames = (walkthrough: boolean) => (walkthrough ? sec(15) : sec(9));

/** A guided tour of a PR: an agent's reading order, the lines it means, and what looks wrong. */
export function PrReview({ walkthrough = false }: { walkthrough?: boolean }) {
  const frame = useCurrentFrame();
  const step = frame >= NEXT_AT ? 2 : 1;
  const focus = { start: STEPS[step].startLine ?? 0, end: STEPS[step].endLine ?? 0 };

  return (
    <AppScene
      tab="prs"
      shots={[
        ...swingIn(),
        closeUp(40, 820, 520, 1.25),
        closeUp(NEXT_AT + 6, 940, 600, 1.45),
        ...(walkthrough
          ? [closeUp(ASK_AT - 10, 700, 600, 1.4), framed(ASK_AT + 150)]
          : [framed(NEXT_AT + 110)]),
      ]}
      cursor={[
        { at: NEXT_AT - 30, x: 700, y: 400 },
        { at: NEXT_AT - 20, x: 838, y: 731, dur: 16, click: true },
      ]}
      caption={{
        kicker: "PR review",
        title: "Guided tours, and questions about any line",
        pointsAt: 50,
        pointStep: walkthrough ? 40 : 50,
        points: walkthrough
          ? [
              <>
                An agent lays out a <Em>reading order</Em>, outside in
              </>,
              <>
                Each step names the lines, and <Em>what looks wrong</Em>
              </>,
              <>
                <Em>Next</Em> marks the step's files as viewed on GitHub
              </>,
              <>
                Press <Em>?</Em> on any line to ask about it
              </>,
            ]
          : [<>A reading order from an agent</>, <>With the problems it found</>],
      }}
    >
      <PrReviewView
        title="Refresh sessions before expiry"
        number={218}
        repo="acme/auth-service · sam"
        files={FILES}
        // Each step so far covered one file, in list order.
        viewed={step}
        selected="src/auth/session.ts"
        guide={staticGuide(STEPS, step)}
      >
        <DiffFile
          path="src/auth/session.ts"
          patch={PATCH}
          add={18}
          del={2}
          focus={focus}
          below={
            walkthrough && frame >= ASK_AT
              ? {
                  line: 57,
                  node: (
                    <div
                      className="max-w-[58%] rounded-lg border border-violet-900 bg-violet-950/20 p-3 text-sm"
                      style={enter(frame, ASK_AT)}
                    >
                      <div className="mb-1 flex items-center gap-2 text-xs">
                        <span className="font-medium text-violet-300">Insight</span>
                        <span className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-zinc-400">
                          Post
                        </span>
                      </div>
                      <div className="mb-2 text-xs italic text-zinc-400">{QUESTION}</div>
                      <div className="text-zinc-200">
                        {typed(
                          "The error is dropped and no new timer is set, so the access token expires and nothing retries until the next request fails with a 401.",
                          frame,
                          ASK_AT + 20,
                          70,
                        )}
                      </div>
                    </div>
                  ),
                }
              : undefined
          }
        />
      </PrReviewView>
    </AppScene>
  );
}
