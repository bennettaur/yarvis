import type { Tab } from "../shell/nav";

export interface TourStep {
  /** The `data-tour` value of the element to highlight; none centers the card. */
  target?: string;
  /** The tab to show while this step is up, so the user sees the page it describes. */
  tab?: Tab;
  title: string;
  body: string;
}

/**
 * The app tour, in nav-rail order. Each page step switches to that page; the
 * rail buttons carry `data-tour` set to their tab id (or the overlay's name).
 */
export const TOUR_STEPS: TourStep[] = [
  {
    title: "A quick tour of Yarvis",
    body: "This walks through each page in the nav rail on the left. Use the arrow keys or the buttons to move, and Esc to stop at any time.",
  },
  {
    target: "chat",
    tab: "chat",
    title: "Chat",
    body: "A full-page chat with the assistant. It remembers what you tell it, keeps your tasks, and can start work in a workspace. Pick the provider and model at the top.",
  },
  {
    target: "omni",
    tab: "omni",
    title: "Omni",
    body: 'A canvas you build by describing it, such as "my PRs next to today\'s calendar". Save a layout to come back to it.',
  },
  {
    target: "terminal",
    tab: "terminal",
    title: "Terminal",
    body: "A terminal with tabs and split panes. Shells keep running when you switch to another page.",
  },
  {
    target: "workspaces",
    tab: "workspaces",
    title: "Workspaces",
    body: "One folder per piece of work, with a git worktree for each repo and a Claude Code session at its root. Add your repos in Settings → Repositories first.",
  },
  {
    target: "tasks",
    tab: "tasks",
    title: "Tasks",
    body: "Your own to-do list for today and this week. The assistant adds to it when you tell it what you need to do.",
  },
  {
    target: "prs",
    tab: "prs",
    title: "PRs",
    body: "Pull requests waiting on you, from GitHub or Azure DevOps, with a guided review and line-by-line questions. Needs a token in Settings → Credentials.",
  },
  {
    target: "issues",
    tab: "issues",
    title: "Issues",
    body: "GitHub issues and JIRA tickets. Start work on one and Yarvis creates a workspace and starts a Claude Code session on it.",
  },
  {
    target: "memory",
    tab: "memory",
    title: "Memory",
    body: "What the assistant knows and is doing: memories, projects and their priorities, recent events, and the todos it has taken on.",
  },
  {
    target: "calendar",
    tab: "calendar",
    title: "Calendar",
    body: "Your Google Calendar. The assistant reads it to plan your week. Connect it from this page once a Google client is set in Settings → Credentials.",
  },
  {
    target: "alarms",
    tab: "alarms",
    title: "Alarms",
    body: "Meeting alarms that take over the screen and keep sounding until you acknowledge them.",
  },
  {
    target: "jobs",
    tab: "jobs",
    title: "Jobs",
    body: "Prompts that run on a schedule, like a weekday-morning summary. Every run is kept with what the agent said.",
  },
  {
    target: "sessions",
    tab: "sessions",
    title: "Sessions",
    body: "Browse your past Claude Code sessions and plans, and read their transcripts.",
  },
  {
    target: "clipboard",
    title: "Clipboard",
    body: "Saved snippets and this session's clipboard history, ready to paste again.",
  },
  {
    target: "shortcuts",
    title: "Keyboard shortcuts",
    body: "Every shortcut, grouped by where it applies. Cmd+/ opens it from anywhere. Hold Cmd to see each nav button's number.",
  },
  {
    target: "omnichat",
    title: "Omni Chat",
    body: "A chat overlay you can summon over any page. It sees what you're looking at, so you can ask about it directly.",
  },
  {
    target: "dashboard",
    tab: "dashboard",
    title: "Dashboard",
    body: "Read-only status: whether the database is reachable and which providers have keys. Check here first when something isn't working.",
  },
  {
    target: "settings",
    tab: "settings",
    title: "Settings",
    body: "Credentials, LLM providers, MCP servers, repositories, voice and the rest. Everything the setup guide did can be changed here.",
  },
  {
    target: "help",
    title: "Help",
    body: "Opens the setup guide or this tour again. Once chat works, you can also ask the assistant where a setting is or how to configure something, and it will point you to it.",
  },
];
