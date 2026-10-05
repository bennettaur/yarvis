/**
 * What the fake model says. Replies are matched against the user's latest
 * message, and only replies for the same surface are considered: entries with
 * `surface: "omni"` answer the Omni tab's layout builder, the rest answer chat.
 * The first match wins, so put specific patterns before general ones.
 *
 * Replies refer to the data in `demo/seed.ts`; keep the two in step. Flows run
 * in order against one database, so avoid counts that an earlier flow's
 * additions would make wrong.
 */

interface ReplyBase {
  /** Tested against the user's latest message. */
  when: RegExp;
  surface?: "omni";
}

export type Reply = ReplyBase &
  (
    | {
        /** Markdown for chat; one line of prose plus a ```spec block of JSON patches for Omni. */
        text: string;
      }
    | {
        /** A tool the model calls instead of answering straight away. The sidecar runs it for real. */
        toolCall: { name: string; args: Record<string, unknown> };
        /** What the model says once the tool has run. */
        after: string;
      }
  );

/**
 * Tools a canned reply may call. The sidecar runs whatever the model asks for,
 * and some built-ins reach outside the demo (shell commands, git, delegating
 * to a real provider), so only ones that touch the demo database are allowed.
 */
export const SAFE_TOOLS = new Set([
  "create_task",
  "list_tasks",
  "complete_task",
  "update_task",
  "remember",
  "recall",
  "list_memories",
  "take_note",
]);

/**
 * The next Friday after today (a week out when today is Friday), as
 * YYYY-MM-DD. Uses UTC, as the Tasks panel does when it decides what's "today".
 */
function nextFriday(): string {
  const d = new Date();
  const daysAhead = (5 - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

/** One JSON patch per line, the way Omni's parser expects them. */
function spec(...patches: object[]): string {
  return ["```spec", ...patches.map((p) => JSON.stringify(p)), "```", ""].join("\n");
}

function addElement(key: string, type: string, props: object, children: string[] = []) {
  return { op: "add", path: `/elements/${key}`, value: { type, props, children } };
}

export const REPLIES: Reply[] = [
  {
    when: /plate|this week|what.*(on|do) i/i,
    text: [
      "Here's where your week stands:",
      "",
      "**Today**",
      "- Prep demo for Thursday's review",
      "- Reply to the design feedback thread",
      "",
      "**This week**",
      "- Get the payment step to code complete",
      "",
      "Priya's payment-step PR is your most urgent review, and it's due tomorrow. For Thursday, you noted you want to show the new payment step and the load-time chart.",
    ].join("\n"),
  },
  {
    when: /rollout plan|remind me|add a task/i,
    toolCall: {
      name: "create_task",
      args: { title: "Send the rollout plan to Priya", scope: "weekly", targetDate: nextFriday() },
    },
    after:
      "Added **Send the rollout plan to Priya** to this week, due Friday. It's on your Tasks list now, next to the checkout flag work.",
  },
  {
    when: /looking at|summari[sz]e|this screen/i,
    text: [
      "You're on your task list. The two due today:",
      "",
      "1. **Prep demo for Thursday's review**",
      "2. **Reply to the design feedback thread**",
      "",
      "The demo prep is the one with a hard deadline. Want me to block out an hour for it tomorrow morning, before your 11am cutoff?",
    ].join("\n"),
  },
  {
    surface: "omni",
    when: /focus|board|dashboard|checkout/i,
    text: [
      "Here's a focus board for the checkout work: your tasks and pull requests on the left, today's calendar and a terminal on the right.",
      spec(
        { op: "add", path: "/root", value: "main" },
        addElement("main", "Column", { gap: 8 }, ["title", "subtitle", "body"]),
        addElement("title", "Heading", { text: "Checkout redesign", level: 1 }),
        addElement("subtitle", "Text", {
          text: "Ship the new payment step behind a flag · review on Thursday",
          muted: true,
        }),
        addElement("body", "Row", { gap: 8 }, ["left", "right"]),
        addElement("left", "Column", { gap: 8 }, ["tasks", "prs"]),
        addElement("tasks", "Tasks", { title: "Today", height: 340 }),
        addElement("prs", "PullRequests", { title: "Pull requests", height: 340 }),
        addElement("right", "Column", { gap: 8 }, ["calendar", "terminal"]),
        addElement("calendar", "CalendarDay", { title: "Today's calendar", height: 340 }),
        addElement("terminal", "Terminal", { title: "checkout-web", sessionId: "omni-checkout" }),
      ),
    ].join("\n"),
  },
];

/** For a chat message no reply matches. Worded so it's easy to spot in a screenshot. */
export const DEFAULT_REPLY: Reply = {
  when: /.*/,
  text: "I can help with that. This is a scripted demo reply; add a matching entry to `demo/fakeLlm/script.ts` for a real answer.",
};

/** For an Omni request no reply matches: a bare task list. */
export const OMNI_DEFAULT_REPLY: Reply = {
  when: /.*/,
  surface: "omni",
  text: `This is a scripted demo layout; add a matching entry to demo/fakeLlm/script.ts.\n${spec(
    { op: "add", path: "/root", value: "main" },
    addElement("main", "Tasks", { title: "Tasks" }),
  )}`,
};
