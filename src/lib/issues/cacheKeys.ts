/**
 * The `lib/resourceCache` key namespaces the issue views read under, shared with
 * the Settings surfaces that have to drop them. A prefix that is a string
 * literal at both ends is a rename away from silently invalidating nothing — or,
 * worse, everything — so the two ends hold the same value instead.
 */

/** Everything either issue view reads. */
export const ISSUES_PREFIX = "issues:";

/** The GitHub view's own resources, which repo configuration decides. */
export const GITHUB_ISSUES_PREFIX = "issues:github:";

/** The JIRA view's own resources. */
export const JIRA_ISSUES_PREFIX = "issues:jira:";
