/** The tabs inside Settings, in the order the page shows them. */
export const SETTINGS_TABS = [
  { key: "credentials", label: "Credentials" },
  { key: "providers", label: "LLM Providers" },
  { key: "tools", label: "Tools & MCP" },
  { key: "repos", label: "Repositories" },
  { key: "prs", label: "PR review" },
  { key: "voice", label: "Voice" },
  { key: "embeddings", label: "Embeddings" },
  { key: "telegram", label: "Telegram" },
  { key: "wip", label: "Work in progress" },
  { key: "assistant", label: "Assistant" },
  { key: "diagnostics", label: "Diagnostics" },
] as const;

export type SettingsTabKey = (typeof SETTINGS_TABS)[number]["key"];

export function isSettingsTabKey(value: unknown): value is SettingsTabKey {
  return SETTINGS_TABS.some((t) => t.key === value);
}

export const SETTINGS_TAB_STORAGE_KEY = "yarvis.settings.activeTab";
