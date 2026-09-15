import { describe, expect, it } from "bun:test";
import { GITHUB_ISSUES_PREFIX, ISSUES_PREFIX, JIRA_ISSUES_PREFIX } from "./issues/cacheKeys";
import { PRS_PROBE_PREFIX, prsListPrefix } from "./pr/cacheKeys";

/**
 * What a Settings surface drops when the user saves. A prefix that reaches too
 * far spends a rate-limited provider's quota on data the setting didn't touch; a
 * prefix that reaches too short leaves the user staring at an answer they just
 * changed. Both failures are silent, so the boundaries are asserted here rather
 * than left to whoever next renames a key.
 */
describe("cache key namespaces", () => {
  it("keeps the two issue providers out of each other's reach", () => {
    // Repo configuration is GitHub-only, so saving one must not spend JIRA quota.
    expect(`${JIRA_ISSUES_PREFIX}assigned`.startsWith(GITHUB_ISSUES_PREFIX)).toBe(false);
    expect(`${GITHUB_ISSUES_PREFIX}assigned`.startsWith(JIRA_ISSUES_PREFIX)).toBe(false);
  });

  it("puts both issue providers under the prefix that means all of them", () => {
    expect(GITHUB_ISSUES_PREFIX.startsWith(ISSUES_PREFIX)).toBe(true);
    expect(JIRA_ISSUES_PREFIX.startsWith(ISSUES_PREFIX)).toBe(true);
  });

  it("leaves the provider probes outside the PR list prefixes", () => {
    // The probes are held for ten minutes because credentials rarely change.
    // Saving the needs-review query says nothing about them, so a prefix that
    // swept them up would re-probe both providers on the next visit.
    for (const provider of ["github", "azure"] as const) {
      expect(`${PRS_PROBE_PREFIX}${provider}`.startsWith(prsListPrefix(provider))).toBe(false);
    }
  });

  it("keeps the two PR providers out of each other's reach", () => {
    expect(`${prsListPrefix("azure")}lists`.startsWith(prsListPrefix("github"))).toBe(false);
    expect(`${prsListPrefix("github")}lists`.startsWith(prsListPrefix("azure"))).toBe(false);
  });
});
