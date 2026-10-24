/**
 * The floor under a pull request's risk tier, from the files it touches and
 * its size. This only catches paths that are dangerous whatever the change
 * does there, and changes too big to review well. Everything else starts low,
 * whichever part of the app it is in: how risky a change is depends on what
 * it does, which the `/verify-pr` skill assesses and signs into the report.
 * The tier a PR gets is the stricter of the two. Both the skill and the CI
 * gate compute this floor, and the gate trusts its own over the report's.
 */

export type Tier = "low" | "standard" | "high";

export interface ChangedFile {
  path: string;
  /** The old path of a renamed file, which is classified too. */
  previousPath?: string;
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
  // Instructions and hooks the verifying agent itself loads.
  { pattern: /^(\.claude\/|CLAUDE\.md$|AGENTS\.md$)/, reason: "agent instructions or hooks" },
  { pattern: /^lefthook\.yml$/, reason: "git hooks" },
  {
    pattern:
      /^((sidecar\/)?(bunfig\.toml|tsconfig[^/]*\.json)|mise\.toml|vite\.config\.ts|biome\.json|\.npmrc)$/,
    reason: "build or test config, which runs code",
  },
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

/**
 * Past these sizes a reviewer, human or agent, starts missing things. Counted
 * on code only: lockfiles, tests and docs inflate the number without adding risk.
 */
const STANDARD_SIZE_LINES = 300;
const HIGH_SIZE_LINES = 800;

const TIER_ORDER: Tier[] = ["low", "standard", "high"];

export function stricterTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

/** Only `*.test.ts(x)`: a `test/` directory also holds preloads and helpers, which are code. */
export function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
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

  const paths = files.flatMap((file) =>
    file.previousPath ? [file.path, file.previousPath] : [file.path],
  );
  for (const path of paths) {
    // Tests count too: the verifier's own tests are part of the verifier.
    const high = HIGH_RISK_PATHS.find((rule) => rule.pattern.test(path));
    if (high) note("high", high.reason, path);
  }

  const codeLines = files
    .filter((file) => isCode(file.path))
    .reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (codeLines > HIGH_SIZE_LINES) note("high", `${codeLines} changed lines of code`);
  else if (codeLines > STANDARD_SIZE_LINES) note("standard", `${codeLines} changed lines of code`);

  const tier: Tier = byTier.high.size > 0 ? "high" : byTier.standard.size > 0 ? "standard" : "low";
  // Only the winning tier's reasons: the report says why it is high, not
  // that it is also big.
  const reasons = [...byTier[tier]].map(([reason, paths]) => {
    if (paths.length === 0) return reason;
    return paths.length === 1 ? `${reason} (${paths[0]})` : `${reason} (${paths.length} files)`;
  });
  return { tier, reasons };
}
