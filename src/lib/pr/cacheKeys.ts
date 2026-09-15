/**
 * The `lib/resourceCache` key namespaces the PRs panel reads under, shared with
 * the Settings surfaces that have to drop them. A prefix that is a string
 * literal at both ends is a rename away from silently invalidating nothing — or,
 * worse, everything — so the two ends hold the same value instead.
 *
 * The probes sit outside {@link PRS_LIST_PREFIX} deliberately: they are held far
 * longer than the lists, and a settings change that alters what a list holds
 * says nothing about whether a provider is configured.
 */

/** Whether each provider's credentials work. */
export const PRS_PROBE_PREFIX = "prs:viewer:";

/** One provider's lists, filters and stars. */
export const prsListPrefix = (provider: "github" | "azure") => `prs:${provider}:`;
