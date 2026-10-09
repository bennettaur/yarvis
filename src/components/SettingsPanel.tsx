import { SETTINGS_TABS, type SettingsTabKey, useSettingsTab } from "../lib/settingsTabs";
import AgentSection from "./AgentSection";
import ChatBudgetSection from "./ChatBudgetSection";
import ComplexityModelSection from "./ComplexityModelSection";
import CustomProviderSection from "./CustomProviderSection";
import DiagnosticsSection from "./DiagnosticsSection";
import EmbeddingsSection from "./EmbeddingsSection";
import IntegrationSettingsSection from "./IntegrationSettingsSection";
import JobsSection from "./JobsSection";
import KeychainSection from "./KeychainSection";
import McpEndpointSection from "./McpEndpointSection";
import McpServerSection from "./McpServerSection";
import ModelCatalogSection from "./ModelCatalogSection";
import PrModelSection from "./PrModelSection";
import PrReviewSection from "./PrReviewSection";
import ReposSection from "./ReposSection";
import SecretBackendSection from "./SecretBackendSection";
import SpecialistSection from "./SpecialistSection";
import TelegramSection from "./TelegramSection";
import TerminalSection from "./TerminalSection";
import ToolManagerSection from "./ToolManagerSection";
import VoiceSection from "./VoiceSection";
import WipSection from "./WipSection";

/**
 * The Settings tab — where the user configures credentials, custom LLM
 * providers, MCP servers, and tool policies. Health/status indicators stay on
 * the Dashboard tab. Sections are grouped into tabs so each one stays
 * self-contained and the page doesn't become an ever-growing scroll.
 */
export default function SettingsPanel({
  requestedTab = null,
  onRequestConsumed,
}: {
  /** A tab to switch to, asked for by a `yarvis://settings/...` link or the setup guide. */
  requestedTab?: SettingsTabKey | null;
  onRequestConsumed?: () => void;
} = {}) {
  const [active, select] = useSettingsTab(requestedTab, onRequestConsumed);

  return (
    <div className="space-y-5">
      <nav className="flex gap-1 border-b border-zinc-800">
        {SETTINGS_TABS.map((tab) => (
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

      {active === "credentials" && (
        <div className="space-y-5">
          <SecretBackendSection />
          <KeychainSection />
          <IntegrationSettingsSection />
        </div>
      )}
      {active === "providers" && (
        <div className="space-y-5">
          <ModelCatalogSection />
          <CustomProviderSection />
        </div>
      )}
      {active === "tools" && (
        <div className="space-y-5">
          <McpServerSection />
          <McpEndpointSection />
          <ToolManagerSection />
        </div>
      )}
      {active === "repos" && (
        <div className="space-y-5">
          <ReposSection />
          <AgentSection />
          <TerminalSection />
        </div>
      )}
      {active === "assistant" && (
        <div className="space-y-5">
          <ChatBudgetSection />
          <ComplexityModelSection />
          <SpecialistSection />
          <JobsSection />
        </div>
      )}
      {active === "prs" && (
        <div className="space-y-5">
          <PrReviewSection />
          <PrModelSection />
        </div>
      )}
      {active === "voice" && <VoiceSection />}
      {active === "embeddings" && <EmbeddingsSection />}
      {active === "telegram" && <TelegramSection />}
      {active === "wip" && <WipSection />}
      {active === "diagnostics" && <DiagnosticsSection />}
    </div>
  );
}
