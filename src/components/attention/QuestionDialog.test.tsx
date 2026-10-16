import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { AttentionItem } from "../../lib/attention";
import type { AgentQuestion, QuestionAnswer } from "../../lib/questions";
import { mountForInteraction } from "../../test/render";

const QUESTION: AgentQuestion = {
  id: "q1",
  sessionKey: "ws-claude:w1",
  workspaceId: "w1",
  context: {
    task: "Adding rate limiting to the public API",
    reason: "The choice changes the config shape",
  },
  questions: [
    {
      question: "Which limiter should the API use?",
      header: "Limiter",
      options: [
        { label: "Token bucket", description: "Allows short bursts" },
        { label: "Fixed window" },
      ],
    },
    { question: "Anything else I should know?" },
  ],
  status: "pending",
  createdAt: "2026-10-16T12:00:00.000Z",
};

const answered: { id: string; answers: QuestionAnswer[] }[] = [];
const declined: string[] = [];

mock.module("../../lib/questions", () => ({
  questionsForItem: async () => [QUESTION],
  answerQuestion: async (id: string, answers: QuestionAnswer[]) => {
    answered.push({ id, answers });
  },
  declineQuestion: async (id: string) => {
    declined.push(id);
  },
}));

const QuestionDialog = (await import("./QuestionDialog")).default;

const ITEM: AttentionItem = {
  id: "a1",
  seq: 1,
  source: "system",
  sessionKey: "ws-claude:w1",
  workspaceId: "w1",
  kind: "question",
  title: "Fix the API",
  body: "Which limiter should the API use?",
  status: "pending",
  navTarget: { type: "workspace-claude", workspaceId: "w1" },
  createdAt: "2026-10-16T12:00:00.000Z",
  updatedAt: "2026-10-16T12:00:00.000Z",
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

let unmount: (() => void) | null = null;
let closed = 0;

afterEach(() => {
  unmount?.();
  unmount = null;
  answered.length = 0;
  declined.length = 0;
  closed = 0;
});

async function mountDialog(): Promise<HTMLElement> {
  const mounted = await mountForInteraction(
    createElement(QuestionDialog, {
      item: ITEM,
      onClose: () => {
        closed++;
      },
      onOpenSession: () => {},
    }),
  );
  unmount = mounted.unmount;
  return mounted.host;
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

/** Sets a textarea's value the way React's change tracking notices. */
function type(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("QuestionDialog", () => {
  it("shows the workspace, the agent's task and reason, and each question", async () => {
    const text = (await mountDialog()).textContent ?? "";
    expect(text).toContain("Fix the API");
    expect(text).toContain("Adding rate limiting to the public API");
    expect(text).toContain("The choice changes the config shape");
    expect(text).toContain("Which limiter should the API use?");
    expect(text).toContain("Allows short bursts");
    expect(text).toContain("Anything else I should know?");
  });

  it("sends the picked option and typed text once every question has an answer", async () => {
    const host = await mountDialog();
    const send = button(host, "Send answers");
    expect(send.disabled).toBe(true);

    button(host, "Token bucket").click();
    await settle();
    expect(send.disabled).toBe(true);

    const free = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Answer 2"]');
    type(free!, "Keep it per-user");
    await settle();
    expect(send.disabled).toBe(false);

    send.click();
    await settle();
    expect(answered).toEqual([
      {
        id: "q1",
        answers: [{ selected: ["Token bucket"] }, { selected: [], text: "Keep it per-user" }],
      },
    ]);
    expect(closed).toBe(1);
  });

  it("declines when the user skips", async () => {
    const host = await mountDialog();
    button(host, "Skip").click();
    await settle();
    expect(declined).toEqual(["q1"]);
    expect(closed).toBe(1);
  });
});
