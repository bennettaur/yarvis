import CustomProviderSection from "./CustomProviderSection";
import ReposSection from "./ReposSection";
import SecretsSection from "./SecretsSection";

/**
 * The Settings tab — where the user configures credentials and custom LLM
 * providers. Health/status indicators stay on the Dashboard tab.
 */
export default function SettingsPanel() {
  return (
    <div className="space-y-6">
      <SecretsSection />
      <CustomProviderSection />
      <ReposSection />
    </div>
  );
}
