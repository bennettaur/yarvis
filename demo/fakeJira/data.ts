/**
 * The JIRA the demo sees: one project with a handful of tickets on the
 * checkout work. Every name is made up. PAY-142 is the one the JIRA flow
 * opens, so it carries a description, comments and a linked ticket.
 */

export const SITE_URL = "https://acme.atlassian.net";

export interface FakeUser {
  accountId: string;
  displayName: string;
  emailAddress: string;
}

export const VIEWER: FakeUser = {
  accountId: "acct-alex",
  displayName: "Alex Rivera",
  emailAddress: "alex@example.com",
};
const PRIYA: FakeUser = {
  accountId: "acct-priya",
  displayName: "Priya Shah",
  emailAddress: "priya@example.com",
};
const SAM: FakeUser = {
  accountId: "acct-sam",
  displayName: "Sam Okafor",
  emailAddress: "sam@example.com",
};
export const PEOPLE = [VIEWER, PRIYA, SAM];

export const PROJECT = { id: "10001", key: "PAY", name: "Payments" };
export const ISSUE_TYPES = [
  { id: "1", name: "Task", subtask: false },
  { id: "2", name: "Bug", subtask: false },
  { id: "3", name: "Story", subtask: false },
];

/** The workflow every ticket follows. Any status can move to any other. */
export const STATUSES = [
  { transitionId: "11", name: "To Do", category: "new" },
  { transitionId: "21", name: "In Progress", category: "indeterminate" },
  { transitionId: "31", name: "In Review", category: "indeterminate" },
  { transitionId: "41", name: "Done", category: "done" },
] as const;
export type StatusName = (typeof STATUSES)[number]["name"];

export interface FakeTicket {
  key: string;
  summary: string;
  description: string;
  issueType: string;
  priority: string;
  status: StatusName;
  assignee: FakeUser | null;
  reporter: FakeUser;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: { author: FakeUser; text: string; createdAt: string }[];
  /** Keys of tickets this one blocks. */
  blocks: string[];
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

export const TICKETS: FakeTicket[] = [
  {
    key: "PAY-142",
    summary: "Show the card brand logo on saved cards",
    description:
      "Returning customers pick a saved card by its last four digits alone. Show the Visa, Mastercard or Amex mark beside each one so the right card is obvious at a glance.",
    issueType: "Story",
    priority: "High",
    status: "In Progress",
    assignee: VIEWER,
    reporter: PRIYA,
    labels: ["checkout", "saved-cards"],
    createdAt: hoursAgo(72),
    updatedAt: hoursAgo(3),
    comments: [
      {
        author: PRIYA,
        text: "Design has the logo set ready in the shared Figma file. Use the SVGs, not the PNG sprite.",
        createdAt: hoursAgo(20),
      },
    ],
    blocks: ["PAY-131"],
  },
  {
    key: "PAY-139",
    summary: "Retry a declined card against the same payment intent",
    description: "A retry creates a second intent today, which can charge a customer twice.",
    issueType: "Bug",
    priority: "Highest",
    status: "To Do",
    assignee: VIEWER,
    reporter: SAM,
    labels: ["checkout"],
    createdAt: hoursAgo(50),
    updatedAt: hoursAgo(10),
    comments: [],
    blocks: [],
  },
  {
    key: "PAY-131",
    summary: "Chart checkout load time on the perf dashboard",
    description: "Plot `checkout.load` p50 and p95 per device class.",
    issueType: "Task",
    priority: "Medium",
    status: "In Review",
    assignee: VIEWER,
    reporter: VIEWER,
    labels: ["performance"],
    createdAt: hoursAgo(120),
    updatedAt: hoursAgo(26),
    comments: [],
    blocks: [],
  },
  {
    key: "PAY-118",
    summary: "Move the payment step behind the checkout-v2 flag",
    description: "Gate the new step so it can roll out to 10% of returning customers first.",
    issueType: "Task",
    priority: "Medium",
    status: "In Progress",
    assignee: SAM,
    reporter: VIEWER,
    labels: ["checkout", "flags"],
    createdAt: hoursAgo(200),
    updatedAt: hoursAgo(30),
    comments: [],
    blocks: [],
  },
];
