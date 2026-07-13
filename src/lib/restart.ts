import { getHealth, waitForSidecarReady } from "./api";
import { restartSidecar } from "./keychain";

/**
 * Restarts the sidecar and waits for it to come back ready before resolving.
 * Captures the current uptime first so the readiness poll doesn't accept the
 * old process answering during the restart window. Needed after any secret
 * change, since secrets are injected into the sidecar only at spawn time.
 */
export async function restartAndWait(): Promise<void> {
  let priorUptimeMs: number | undefined;
  try {
    priorUptimeMs = (await getHealth()).uptimeMs;
  } catch {
    // If the sidecar is already down, the restart will spawn a fresh one and
    // the readiness poll will pick it up without an uptime baseline.
  }
  await restartSidecar();
  await waitForSidecarReady({ minUptimeMsBefore: priorUptimeMs });
}
