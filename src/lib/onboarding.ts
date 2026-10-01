import { getStatus } from "./api";
import { listProviders, type ProviderInfo } from "./chat";

/** Set the first time the setup guide closes, by any route, so it stops opening itself. */
export const SETUP_GUIDE_SEEN_KEY = "yarvis.setupGuide.seen";

export function markSetupGuideSeen(): void {
  localStorage.setItem(SETUP_GUIDE_SEEN_KEY, "1");
}

function hasSeenSetupGuide(): boolean {
  return localStorage.getItem(SETUP_GUIDE_SEEN_KEY) !== null;
}

/**
 * The chat providers the user has actually configured. Bedrock always reports
 * available because its AWS credentials can't be checked cheaply, so it
 * doesn't count as proof the user set anything up.
 */
export function configuredChatProviders(providers: ProviderInfo[]): ProviderInfo[] {
  return providers.filter((p) => p.available && p.id !== "bedrock");
}

export function hasConfiguredChatProvider(providers: ProviderInfo[]): boolean {
  return configuredChatProviders(providers).length > 0;
}

/**
 * Whether the setup guide should open by itself on launch: it has never been
 * closed, and the app is missing a database or a chat provider. An existing
 * install that has both never sees it.
 */
export function setupGuideNeeded(state: {
  seen: boolean;
  databaseConfigured: boolean;
  providers: ProviderInfo[];
}): boolean {
  if (state.seen) return false;
  return !state.databaseConfigured || !hasConfiguredChatProvider(state.providers);
}

/** {@link setupGuideNeeded}, asking the sidecar only when the guide hasn't been closed yet. */
export async function shouldAutoOpenSetupGuide(): Promise<boolean> {
  if (hasSeenSetupGuide()) return false;
  const [status, providers] = await Promise.all([getStatus(), listProviders("chat")]);
  return setupGuideNeeded({
    seen: false,
    databaseConfigured: status.databaseConfigured,
    providers,
  });
}
