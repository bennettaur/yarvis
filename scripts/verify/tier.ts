/**
 * Sorts a pull request into a risk tier from the files it touches and its
 * size. The tier caps the verdict a report can give: an LLM reviewer can make
 * the verdict stricter, never looser. Both the `/verify-pr` skill and the CI
 * gate compute it, and the gate trusts its own answer over the report's.
 */

export type Tier = "low" | "standard" | "high";

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface TierResult {
  tier: Tier;
  reasons: string[];
}

interface PathRule {
  pattern: RegExp;
  reason: string;
}

/** Paths where a mistake leaks secrets, widens what the agent may do, or loses data. */
const HIGH_RISK_PATHS: PathRule[] = [
  // The verifier must not be able to approve a change to itself.
  { pattern: /^\.github\//, reason: "CI or repo config" },
  { pattern: /^scripts\/verify\//, reason: "the verification layer itself" },
  { pattern: /^\.claude\/skills\/verify-pr\//, reason: "the verification layer itself" },
  { pattern: /^lefthook\.yml$/, reason: "git hooks" },
  {
    pattern:
      /^src-tauri\/src\/(keychain|secret_store|onepassword|embeddings_secrets|control|pty)\.rs$/,
    reason: "secrets, the control socket or shell access",
  },
  {
    pattern:
      /^src-tauri\/(capabilities\/|tauri[^/]*\.conf\.json$|entitlements\.plist$|Info\.plist$)/,
    reason: "app permissions or signing",
  },
  { pattern: /^sidecar\/src\/(app|server)\.ts$/, reason: "sidecar request handling" },
  {
    pattern: /^sidecar\/src\/(agentTools|mcpServer|settings)\//,
    reason: "agent tool approvals, the MCP server or settings",
  },
  { pattern: /^sidecar\/(drizzle\/|src\/db\/)/, reason: "database schema or migrations" },
  {
    pattern: /^extension\/(page\.js|manifest\.json)$/,
    reason: "what the Chrome extension may do in a page",
  },
  {
    pattern: /(^|\/)(package\.json|bun\.lock|Cargo\.toml|Cargo\.lock|pyproject\.toml|uv\.lock)$/,
    reason: "dependencies",
  },
];

/** Code that runs with the user's privileges or talks to outside services. */
const STANDARD_RISK_PATHS: PathRule[] = [
  { pattern: /^src-tauri\//, reason: "Rust core" },
  { pattern: /^sidecar\//, reason: "sidecar" },
  { pattern: /^extension\//, reason: "Chrome extension" },
  { pattern: /^scripts\//, reason: "dev scripts" },
];

/**
 * Past these sizes a reviewer, human or agent, starts missing things. Counted
 * on code only: lockfiles, tests and docs inflate the number without adding risk.
 */
const STANDARD_SIZE_LINES = 300;
const HIGH_SIZE_LINES = 800;

export function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || /(^|\/)tests?\//.test(path);
}

function isCode(path: string): boolean {
  return !isTestFile(path) && !/(^|\/)(bun\.lock|Cargo\.lock|uv\.lock)$|\.md$/.test(path);
}

export function classify(files: ChangedFile[]): TierResult {
  // The files behind each reason, per tier, so the report can name one file or
  // count many instead of listing every one.
  const byTier: Record<Tier, Map<string, string[]>> = {
    low: new Map(),
    standard: new Map(),
    high: new Map(),
  };
  const note = (tier: Tier, reason: string, path?: string) => {
    const paths = byTier[tier].get(reason) ?? [];
    if (path) paths.push(path);
    byTier[tier].set(reason, paths);
  };

  for (const file of files) {
    const high = HIGH_RISK_PATHS.find((rule) => rule.pattern.test(file.path));
    if (high) {
      note("high", high.reason, file.path);
      continue;
    }
    const standard = STANDARD_RISK_PATHS.find((rule) => rule.pattern.test(file.path));
    if (standard && !isTestFile(file.path)) note("standard", standard.reason, file.path);
  }

  const codeLines = files
    .filter((file) => isCode(file.path))
    .reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (codeLines > HIGH_SIZE_LINES) note("high", `${codeLines} changed lines of code`);
  else if (codeLines > STANDARD_SIZE_LINES) note("standard", `${codeLines} changed lines of code`);

  const tier: Tier = byTier.high.size > 0 ? "high" : byTier.standard.size > 0 ? "standard" : "low";
  // Only the winning tier's reasons: the report says why it is high, not every
  // standard-tier file that also changed.
  const reasons = [...byTier[tier]].map(([reason, paths]) => {
    if (paths.length === 0) return reason;
    return paths.length === 1 ? `${reason} (${paths[0]})` : `${reason} (${paths.length} files)`;
  });
  return { tier, reasons };
}
