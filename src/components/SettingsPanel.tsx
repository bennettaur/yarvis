import CustomProviderSection from "./CustomProviderSection";
import EmbeddingsSection from "./EmbeddingsSection";
import KeychainSection from "./KeychainSection";
import ReposSection from "./ReposSection";
import TelegramSection from "./TelegramSection";

/**
 * The Settings tab — where the user configures credentials and custom LLM
 * providers. Health/status indicators stay on the Dashboard tab.
 */
export default function SettingsPanel() {
  return (
    <div className="space-y-6">
      <KeychainSection />
      <CustomProviderSection />
      <ReposSection />
      <EmbeddingsSection />
      <TelegramSection />
    </div>
  );
}
