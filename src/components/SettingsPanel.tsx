import { useState } from "react";
import CustomProviderSection from "./CustomProviderSection";
import EmbeddingsSection from "./EmbeddingsSection";
import KeychainSection from "./KeychainSection";
import ReposSection from "./ReposSection";
import TelegramSection from "./TelegramSection";
import TerminalSection from "./TerminalSection";
import WipSection from "./WipSection";

type TabKey = "credentials" | "providers" | "repos" | "embeddings" | "telegram" | "wip";

const TABS: { key: TabKey; label: string }[] = [
  { key: "credentials", label: "Credentials" },
  { key: "providers", label: "LLM Providers" },
  { key: "repos", label: "Repositories" },
  { key: "embeddings", label: "Embeddings" },
  { key: "telegram", label: "Telegram" },
  { key: "wip", label: "Work in progress" },
];

const TAB_STORAGE_KEY = "yarvis.settings.activeTab";

/**
 * The Settings tab — where the user configures credentials and custom LLM
 * providers. Health/status indicators stay on the Dashboard tab. Sections are
 * grouped into tabs so each one stays self-contained and the page doesn't
 * become an ever-growing scroll.
 */
export default function SettingsPanel() {
  const [active, setActive] = useState<TabKey>(() => {
    const saved = localStorage.getItem(TAB_STORAGE_KEY) as TabKey | null;
    return saved && TABS.some((t) => t.key === saved) ? saved : "credentials";
  });

  const select = (key: TabKey) => {
    setActive(key);
    localStorage.setItem(TAB_STORAGE_KEY, key);
  };

  return (
    <div className="space-y-5">
      <nav className="flex gap-1 border-b border-zinc-800">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => select(tab.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              active === tab.key
                ? "border-sky-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {active === "credentials" && <KeychainSection />}
      {active === "providers" && <CustomProviderSection />}
      {active === "repos" && (
        <div className="space-y-5">
          <ReposSection />
          <TerminalSection />
        </div>
      )}
      {active === "embeddings" && <EmbeddingsSection />}
      {active === "telegram" && <TelegramSection />}
      {active === "wip" && <WipSection />}
    </div>
  );
}
