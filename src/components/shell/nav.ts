import type { IconName } from "./icons";

/** The views reachable from the nav rail. */
export type Tab =
  | "chat"
  | "omni"
  | "tasks"
  | "prs"
  | "alarms"
  | "sessions"
  | "dashboard";

export interface NavItem {
  id: Tab;
  label: string;
  icon: IconName;
  /** Pin to the bottom of the rail (settings-style). */
  pinBottom?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "omni", label: "Omni", icon: "omni" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
  { id: "prs", label: "PRs", icon: "prs" },
  { id: "alarms", label: "Alarms", icon: "alarms" },
  { id: "sessions", label: "Sessions", icon: "sessions" },
  { id: "dashboard", label: "Dashboard", icon: "dashboard", pinBottom: true },
];

export function tabLabel(tab: Tab): string {
  return NAV_ITEMS.find((i) => i.id === tab)?.label ?? tab;
}
