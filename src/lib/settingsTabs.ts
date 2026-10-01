import { useCallback, useEffect, useState } from "react";

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

/**
 * Which Settings tab is showing: the saved one, until another view asks for a
 * specific tab. The choice is saved so Settings reopens where the user left it.
 */
export function useSettingsTab(
  requestedTab: SettingsTabKey | null,
  onRequestConsumed?: () => void,
): [SettingsTabKey, (key: SettingsTabKey) => void] {
  // Seeded from the request too, not only the effect below, so the saved tab
  // doesn't flash for a frame first.
  const [active, setActive] = useState<SettingsTabKey>(() => {
    if (requestedTab) return requestedTab;
    const saved = localStorage.getItem(SETTINGS_TAB_STORAGE_KEY);
    return isSettingsTabKey(saved) ? saved : "credentials";
  });

  const select = useCallback((key: SettingsTabKey) => {
    setActive(key);
    localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, key);
  }, []);

  useEffect(() => {
    if (!requestedTab) return;
    select(requestedTab);
    onRequestConsumed?.();
  }, [requestedTab, onRequestConsumed, select]);

  return [active, select];
}
