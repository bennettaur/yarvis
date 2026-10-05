/**
 * What the fake model says. The first reply whose `when` matches the user's
 * latest message wins, so put specific patterns before general ones. Replies
 * refer to the data in `demo/seed.ts`; keep the two in step.
 */

export interface CannedReply {
  /** Tested against the user's latest message. */
  when: RegExp;
  /** "omni" answers the Omni tab's layout builder; anything else answers chat. */
  surface?: "chat" | "omni";
  /** Markdown for chat; prose plus a ```spec block of JSON patches for Omni. */
  text?: string;
  /** A tool the model calls instead of answering straight away. The sidecar runs it for real. */
  toolCall?: { name: string; args: Record<string, unknown> };
  /** What the model says once the tool has run. */
  after?: string;
}

/** The coming Friday, as YYYY-MM-DD. */
function nextFriday(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

/** One JSON patch per line, the way Omni's parser expects them. */
function spec(...patches: object[]): string {
  return ["```spec", ...patches.map((p) => JSON.stringify(p)), "```", ""].join("\n");
}

function element(key: string, type: string, props: object, children: string[] = []) {
  return { op: "add", path: `/elements/${key}`, value: { type, props, children } };
}

export const REPLIES: CannedReply[] = [
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
      "You're on your task list. Three things are open:",
      "",
      "1. **Prep demo for Thursday's review**, due today",
      "2. **Reply to the design feedback thread**, due today",
      "3. **Get the payment step to code complete**, this week",
      "",
      "The demo prep is the one with a hard deadline. Want me to block out an hour for it tomorrow morning, before your 11am cutoff?",
    ].join("\n"),
  },
  {
    surface: "omni",
    when: /.*/,
    text: [
      "Here's a focus board for the checkout work: today's tasks and what Yarvis remembers on the left, with a terminal and your alarms on the right.",
      spec(
        { op: "add", path: "/root", value: "main" },
        element("main", "Column", { gap: 8 }, ["title", "subtitle", "body"]),
        element("title", "Heading", { text: "Checkout redesign", level: 1 }),
        element("subtitle", "Text", {
          text: "Ship the new payment step behind a flag · review on Thursday",
          muted: true,
        }),
        element("body", "Row", { gap: 8 }, ["left", "right"]),
        element("left", "Column", { gap: 8 }, ["tasks", "memory"]),
        element("tasks", "Tasks", { title: "Today", height: 340 }),
        element("memory", "Memory", { title: "What Yarvis knows", height: 340 }),
        element("right", "Column", { gap: 8 }, ["terminal", "alarms"]),
        element("terminal", "Terminal", { title: "checkout-web", sessionId: "omni-checkout" }),
        element("alarms", "Alarms", { title: "Alarms", height: 240 }),
      ),
    ].join("\n"),
  },
];

export const DEFAULT_REPLY: CannedReply = {
  when: /.*/,
  text: "I can help with that. This is a scripted demo reply; add a matching entry to `demo/fakeLlm/script.ts` for a real answer.",
};

export const OMNI_DEFAULT_REPLY: CannedReply = {
  when: /.*/,
  surface: "omni",
  text: `Here's a simple layout.\n${spec(
    { op: "add", path: "/root", value: "main" },
    element("main", "Tasks", { title: "Tasks" }),
  )}`,
};
