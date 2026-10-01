import { getStatus } from "./api";
import { listProviders, type ProviderInfo } from "./chat";

/** Set once the user finishes or skips the setup guide, so it stops opening itself. */
export const SETUP_GUIDE_SEEN_KEY = "yarvis.setupGuide.seen";

export function markSetupGuideSeen(): void {
  localStorage.setItem(SETUP_GUIDE_SEEN_KEY, "1");
}

function setupGuideSeen(): boolean {
  return localStorage.getItem(SETUP_GUIDE_SEEN_KEY) !== null;
}

/**
 * A chat provider the user has actually configured. Bedrock always reports
 * available because its AWS credentials can't be checked cheaply, so it
 * doesn't count as proof the user set anything up.
 */
export function hasConfiguredChatProvider(providers: ProviderInfo[]): boolean {
  return providers.some((p) => p.available && p.id !== "bedrock");
}

/**
 * Whether the setup guide should open by itself on launch: the user has never
 * dismissed it, and the app is missing a database or a chat provider. An
 * existing install that has both never sees it.
 */
export async function shouldAutoOpenSetupGuide(): Promise<boolean> {
  if (setupGuideSeen()) return false;
  const [status, providers] = await Promise.all([getStatus(), listProviders("chat")]);
  return !status.databaseConfigured || !hasConfiguredChatProvider(providers);
}
