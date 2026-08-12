import type { IconName } from "./icons";

/** The views reachable from the nav rail. */
export type Tab =
  | "chat"
  | "voice"
  | "omni"
  | "terminal"
  | "workspaces"
  | "tasks"
  | "prs"
  | "issues"
  | "memory"
  | "calendar"
  | "alarms"
  | "sessions"
  | "dashboard"
  | "settings";

export interface NavItem {
  id: Tab;
  label: string;
  icon: IconName;
  /** Pin to the bottom of the rail (settings-style). */
  pinBottom?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "voice", label: "Voice", icon: "voice" },
  { id: "omni", label: "Omni", icon: "omni" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "workspaces", label: "Workspaces", icon: "workspaces" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
  { id: "prs", label: "PRs", icon: "prs" },
  { id: "issues", label: "Issues", icon: "issues" },
  { id: "memory", label: "Memory", icon: "memory" },
  { id: "calendar", label: "Calendar", icon: "calendar" },
  { id: "alarms", label: "Alarms", icon: "alarms" },
  { id: "sessions", label: "Sessions", icon: "sessions" },
  { id: "dashboard", label: "Dashboard", icon: "dashboard", pinBottom: true },
  { id: "settings", label: "Settings", icon: "settings", pinBottom: true },
];

export function tabLabel(tab: Tab): string {
  return NAV_ITEMS.find((i) => i.id === tab)?.label ?? tab;
}
