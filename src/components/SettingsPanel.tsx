import CustomProviderSection from "./CustomProviderSection";
import EmbeddingsSection from "./EmbeddingsSection";
import KeychainSection from "./KeychainSection";
import McpServerSection from "./McpServerSection";
import ToolManagerSection from "./ToolManagerSection";

/**
 * The Settings tab — where the user configures credentials, custom LLM
 * providers, MCP servers, and tool policies. Health/status indicators stay on
 * the Dashboard tab.
 */
export default function SettingsPanel() {
  return (
    <div className="space-y-6">
      <KeychainSection />
      <CustomProviderSection />
      <EmbeddingsSection />
      <McpServerSection />
      <ToolManagerSection />
    </div>
  );
}
