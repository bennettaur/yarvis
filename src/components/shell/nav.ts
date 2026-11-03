import type { IconName } from "./icons";

/** The views reachable from the nav rail. */
export type Tab =
  | "chat"
  | "omni"
  | "terminal"
  | "workspaces"
  | "tasks"
  | "prs"
  | "review"
  | "issues"
  | "memory"
  | "calendar"
  | "alarms"
  | "jobs"
  | "sessions"
  | "heads-down"
  | "voice"
  | "field"
  | "dashboard"
  | "settings";

export interface NavItem {
  id: Tab;
  label: string;
  icon: IconName;
  /** Pin to the bottom of the rail (settings-style). */
  pinBottom?: boolean;
  /** Leave out of the Cmd+1…9 shortcuts, so the tabs after it keep their numbers. */
  noDigit?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "omni", label: "Omni", icon: "omni" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "workspaces", label: "Workspaces", icon: "workspaces" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
  { id: "prs", label: "PRs", icon: "prs" },
  // Off the digits, so Issues, Memory and Calendar keep the numbers they had.
  { id: "review", label: "Review", icon: "review", noDigit: true },
  { id: "issues", label: "Issues", icon: "issues" },
  { id: "memory", label: "Memory", icon: "memory" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "alarms", label: "Alarms", icon: "alarms" },
  { id: "jobs", label: "Jobs", icon: "jobs" },
  { id: "sessions", label: "Sessions", icon: "sessions" },
  { id: "heads-down", label: "Heads down", icon: "headsdown" },
  { id: "voice", label: "Voice", icon: "voice" },
  { id: "field", label: "Agent Field", icon: "field" },
  { id: "dashboard", label: "Dashboard", icon: "dashboard", pinBottom: true },
  { id: "settings", label: "Settings", icon: "settings", pinBottom: true },
];

export function tabLabel(tab: Tab): string {
  return NAV_ITEMS.find((i) => i.id === tab)?.label ?? tab;
}
