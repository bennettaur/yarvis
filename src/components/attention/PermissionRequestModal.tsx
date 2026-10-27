import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  askedQuestions,
  decidePermission,
  getPermissionRequests,
  type PermissionDecision,
  type PermissionRequest,
} from "../../lib/attention";
import type { QuestionItem } from "../../lib/questions";
import { formatRelativeTime } from "../../lib/time";
import { type Draft, EMPTY_DRAFT, emptyDrafts, isAnswered, QuestionField } from "./QuestionField";

/** How often the open modal re-reads the queue, so a prompt answered in the terminal drops out. */
const REFRESH_MS = 2_000;

/** How long a newly promoted request ignores clicks, so a double click can't approve the next one. */
const ARMING_MS = 400;

/**
 * The reply Claude Code reads for each question, keyed by its text: the picked
 * labels comma-separated, then any note on its own line.
 */
function answersByQuestion(questions: QuestionItem[], drafts: Draft[]): Record<string, string> {
  return Object.fromEntries(
    questions.map((q, i) => {
      const draft = drafts[i] ?? EMPTY_DRAFT;
      const parts = [draft.selected.join(", "), draft.text.trim()].filter(Boolean);
      return [q.question, parts.join("\n")];
    }),
  );
}

/**
 * Answers a Claude Code session's permission prompt without leaving the page
 * the user is on. Opened from a `permission` item in the attention panel, for
 * the session that raised it. Shows the front of that session's queue: the
 * tool and its input, where it runs, and what the agent said just before
 * asking, with the same choices Claude Code's own dialog offers. Claude
 * Code's AskUserQuestion asks through this same prompt, so it shows as the
 * questions themselves and is answered here rather than approved.
 *
 * Once the prompt is answered in the terminal, the request is gone and the
 * modal says so.
 */
export default function PermissionRequestModal({
  sessionKey,
  title,
  onClose,
  onGoToSession,
}: {
  /** The session whose prompts to show; null keeps the modal closed. */
  sessionKey: string | null;
  /** The attention item's title, shown until the first request loads. */
  title: string;
  onClose: () => void;
  /** Opens the terminal the session runs in. */
  onGoToSession: () => void;
}) {
  const [requests, setRequests] = useState<PermissionRequest[] | null>(null);
  // Kept apart so a poll that succeeds clears its own blip but not an answer's error.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  // Tagged with the request they belong to, so the next prompt never shows
  // the last one's answers, even for a single render.
  const [draftState, setDraftState] = useState<{ requestId: string; drafts: Draft[] } | null>(null);
  const current = requests?.[0] ?? null;
  const questions = current ? askedQuestions(current) : null;
  const drafts =
    current && draftState?.requestId === current.id
      ? draftState.drafts
      : emptyDrafts(questions ?? []);
  // Only the newest load may land: a poll sent before an answer would otherwise
  // put the answered request back in front.
  const loadSeq = useRef(0);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    if (!sessionKey) return null;
    const seq = ++loadSeq.current;
    try {
      const list = await getPermissionRequests(sessionKey);
      if (seq !== loadSeq.current) return null;
      setRequests(list);
      setLoadError(null);
      return list;
    } catch (e) {
      if (seq === loadSeq.current) setLoadError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [sessionKey]);

  useEffect(() => {
    setRequests(null);
    setLoadError(null);
    setError(null);
    if (!sessionKey) return;
    void load();
    const timer = setInterval(() => {
      if (!busyRef.current) void load();
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
      // Drops any load still in flight for this session.
      loadSeq.current++;
    };
  }, [sessionKey, load]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm per request
  useEffect(() => {
    setArmed(false);
    setMessage("");
    const timer = setTimeout(() => setArmed(true), ARMING_MS);
    return () => clearTimeout(timer);
  }, [current?.id]);

  useEffect(() => {
    if (!sessionKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessionKey, onClose]);

  if (!sessionKey) return null;

  const answer = async (decision: PermissionDecision) => {
    if (!current || !armed || busy) return;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    try {
      const delivered = await decidePermission(current.id, decision);
      if (!delivered) setError("That prompt was already answered or timed out.");
      const remaining = await load();
      // The user asked for the terminal, and that's where the prompt is even
      // when this one had already timed out.
      if (decision.behavior === "terminal") onGoToSession();
      else if (delivered && remaining?.length === 0) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  const disabled = !armed || busy;
  const canSendAnswers = questions !== null && drafts.every(isAnswered);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <button
        type="button"
        aria-label="Close permission request"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={questions ? "Question" : "Permission request"}
        className="relative flex max-h-[85vh] w-[640px] max-w-full flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <div
              className={`text-xs uppercase tracking-wide ${questions ? "text-sky-400" : "text-amber-400"}`}
            >
              {questions ? "Question" : "Permission needed"}
            </div>
            <div className="truncate text-sm font-medium text-zinc-100">
              {current?.workspaceName ?? title}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {requests && requests.length > 1 && (
              <span className="text-xs text-zinc-400">+{requests.length - 1} waiting</span>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-zinc-500 hover:text-zinc-200"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
          {requests === null && !loadError && <p className="text-xs text-zinc-500">Loading…</p>}
          {requests !== null && !current && (
            <p className="text-xs text-zinc-400">
              This session isn't waiting on Yarvis any more. It was answered, or Yarvis handed the
              prompt back to Claude Code in the terminal. Open the session to see where it is.
            </p>
          )}
          {current && (
            <RequestDetails request={current}>
              {questions ? (
                <QuestionList
                  questions={questions}
                  drafts={drafts}
                  onChange={(next) => setDraftState({ requestId: current.id, drafts: next })}
                />
              ) : (
                <ToolInput request={current} />
              )}
            </RequestDetails>
          )}
          {(error ?? loadError) && (
            <p role="alert" className="text-xs text-red-400">
              {error ?? loadError}
            </p>
          )}
        </div>

        <footer className="shrink-0 space-y-2 border-t border-zinc-800 px-4 py-3">
          {current && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const text = message.trim();
                if (text) void answer({ behavior: "deny", message: text });
              }}
              className="flex gap-2"
            >
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={
                  questions
                    ? "Skip, and tell Claude what to do instead…"
                    : "No, and tell Claude what to do instead…"
                }
                aria-label="Tell Claude what to do instead"
                className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={disabled || !message.trim()}
                className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                Send
              </button>
            </form>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onGoToSession}
              title="Open the terminal this session runs in, without answering."
              className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
            >
              Go to session
            </button>
            {current && (
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void answer({ behavior: "terminal" })}
                  disabled={disabled}
                  title="Show this prompt in the terminal instead, with all of Claude Code's options."
                  className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
                >
                  Answer in terminal
                </button>
                <button
                  type="button"
                  onClick={() => void answer({ behavior: "deny" })}
                  disabled={disabled}
                  className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {questions ? "Skip" : "Deny"}
                </button>
                {questions ? (
                  <button
                    type="button"
                    onClick={() =>
                      void answer({
                        behavior: "answer",
                        answers: answersByQuestion(questions, drafts),
                      })
                    }
                    disabled={disabled || !canSendAnswers}
                    className="rounded-md bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                  >
                    Send answers
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void answer({ behavior: "allow" })}
                    disabled={disabled}
                    className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
                  >
                    Approve
                  </button>
                )}
              </div>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

/** The questions of an AskUserQuestion prompt, answered in place of approving it. */
function QuestionList({
  questions,
  drafts,
  onChange,
}: {
  questions: QuestionItem[];
  drafts: Draft[];
  onChange: (drafts: Draft[]) => void;
}) {
  return (
    <div className="space-y-5">
      <p className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
        Claude wrote these questions, and your answers go back to it. Don't type passwords, tokens
        or other secrets.
      </p>
      {questions.map((question, i) => (
        <QuestionField
          // Questions in a prompt are fixed once asked, so the index is stable.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={i}
          index={i}
          question={question}
          draft={drafts[i] ?? EMPTY_DRAFT}
          onChange={(draft) => onChange(drafts.map((d, j) => (j === i ? draft : d)))}
        />
      ))}
    </div>
  );
}

/** The tool and its input, for every prompt except a question. */
function ToolInput({ request }: { request: PermissionRequest }) {
  const { command, description, ...rest } = request.toolInput;
  const isBash = request.toolName === "Bash" && typeof command === "string";
  // Bash shows its command on its own, with any other fields below it so a
  // flag like dangerouslyDisableSandbox is never hidden. Other tools show
  // their whole input.
  const input = isBash ? command : JSON.stringify(request.toolInput, null, 2);
  const otherFields = isBash && Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : null;
  const unsandboxed = request.toolInput.dangerouslyDisableSandbox === true;

  return (
    <div>
      <div className="mb-1 font-medium text-zinc-100">{request.toolName}</div>
      {unsandboxed && (
        <p className="mb-1 rounded border border-red-800 bg-red-950/40 px-2 py-1 text-xs text-red-300">
          Runs outside the sandbox
        </p>
      )}
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950/70 p-2 font-mono text-xs text-zinc-200">
        {input}
      </pre>
      {otherFields && (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950/70 p-2 font-mono text-xs text-zinc-400">
          {otherFields}
        </pre>
      )}
      {isBash && typeof description === "string" && (
        <p className="mt-1 text-xs text-zinc-400">
          <span className="text-zinc-500">Claude's description: </span>
          {description}
        </p>
      )}
    </div>
  );
}

/** What is being asked (`children`), then where it runs and the conversation around it. */
function RequestDetails({
  request,
  children,
}: {
  request: PermissionRequest;
  children: ReactNode;
}) {
  return (
    <>
      <p className="text-[11px] text-zinc-500">{formatRelativeTime(request.createdAt)}</p>
      {children}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {request.cwd && (
          <>
            <dt className="text-zinc-500">Directory</dt>
            <dd className="truncate text-zinc-300" title={request.cwd}>
              {request.cwd}
            </dd>
          </>
        )}
        {request.permissionMode && (
          <>
            <dt className="text-zinc-500">Mode</dt>
            <dd className="text-zinc-300">{request.permissionMode}</dd>
          </>
        )}
      </dl>

      {request.lastReply && (
        <div>
          <div className="mb-1 text-xs text-zinc-500">What Claude said before asking</div>
          <p className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-zinc-800 p-2 text-xs text-zinc-300">
            {request.lastReply}
          </p>
        </div>
      )}
      {request.lastPrompt && (
        <div>
          <div className="mb-1 text-xs text-zinc-500">Your last prompt</div>
          <p className="max-h-24 overflow-auto whitespace-pre-wrap text-xs text-zinc-400">
            {request.lastPrompt}
          </p>
        </div>
      )}
    </>
  );
}
