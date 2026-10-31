import { useState } from "react";
import { listProviders } from "../../lib/chat";
import { invalidate, primeCache, useCachedResource } from "../../lib/resourceCache";
import { listVoiceProviders } from "../../lib/voice";
import { getVoiceConfig, saveVoiceConfig, type VoiceConfig } from "../../lib/voiceConfig";
import { listTakes, listVoiceProfiles } from "../../lib/voiceStudio";
import SpeechServerSection from "./SpeechServerSection";
import VoiceStudio, { STUDIO_TAKES_KEY } from "./VoiceStudio";
import VoicesSection, { VOICE_PROFILES_KEY } from "./VoicesSection";
import { errorText } from "./voiceUi";

const VOICE_CONFIG_KEY = "voice:config";
const VOICE_PROVIDERS_KEY = "voice:providers";
const CHAT_PROVIDERS_KEY = "voice:chat-providers";

/**
 * The Voice page: the local speech server, saved voices, and the studio. Which
 * speech backends a spoken chat turn uses by default stays in Settings → Voice.
 */
export default function VoicePanel() {
  const config = useCachedResource(VOICE_CONFIG_KEY, getVoiceConfig);
  const voices = useCachedResource(VOICE_PROFILES_KEY, listVoiceProfiles);
  const providers = useCachedResource(VOICE_PROVIDERS_KEY, listVoiceProviders);
  const chatProviders = useCachedResource(CHAT_PROVIDERS_KEY, () => listProviders("chat"));
  const takes = useCachedResource(STUDIO_TAKES_KEY, listTakes);

  const [saveError, setSaveError] = useState<string | null>(null);

  async function changeConfig(patch: Partial<VoiceConfig>): Promise<void> {
    setSaveError(null);
    try {
      primeCache(VOICE_CONFIG_KEY, await saveVoiceConfig(patch));
    } catch (e) {
      setSaveError(errorText(e));
    }
  }

  const error =
    saveError ??
    config.error ??
    voices.error ??
    providers.error ??
    chatProviders.error ??
    takes.error;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="space-y-1">
        <h1 className="text-lg font-medium text-zinc-100">Voice</h1>
        <p className="text-sm text-zinc-500">
          Run the local speech server, save voices to speak in, and try text in several voices at
          once.
        </p>
      </header>
      {error && <p className="text-sm text-red-400">{error}</p>}

      <SpeechServerSection
        onProviderReady={() => {
          invalidate(VOICE_PROVIDERS_KEY);
          invalidate(VOICE_CONFIG_KEY);
        }}
      />

      {config.data && (
        <>
          <VoicesSection
            voices={voices.data ?? []}
            providers={providers.data ?? []}
            config={config.data}
            onConfigChange={changeConfig}
          />
          <VoiceStudio
            voices={voices.data ?? []}
            takes={takes.data ?? []}
            chatProviders={chatProviders.data ?? []}
            config={config.data}
            onConfigChange={changeConfig}
          />
        </>
      )}
    </div>
  );
}
