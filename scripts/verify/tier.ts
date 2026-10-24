/**
 * Sorts a pull request into a risk tier from the files it touches and its
 * size. The tier caps the verdict a report can give: an LLM reviewer can make
 * the verdict stricter, never looser. Both the `/verify-pr` skill and the CI
 * gate compute it, and the gate trusts its own answer over the report's.
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

/**
 * The only frontend files that may make calls that can leak a secret or run a
 * command (listed in `nativeBridge.ts`). It holds the rest of `src/` to that,
 * which is what lets the frontend otherwise count as low risk.
 */
export const PRIVILEGED_FRONTEND_FILES = ["src/lib/privilegedCommands.ts", "src/lib/api.ts"];

/**
 * The files that import `privilegedCommands.ts`. They choose the values its
 * calls run with, such as the command a new MCP server starts, so a change to
 * one is as risky as a change to it. `nativeBridge.ts` fails CI when a file
 * imports it without being listed here.
 */
export const PRIVILEGED_FRONTEND_IMPORTERS = [
  "src/components/AgentSection.tsx",
  "src/components/CustomProviderSection.tsx",
  "src/components/EmbeddingsSection.tsx",
  "src/components/KeychainSection.tsx",
  "src/components/McpServerSection.tsx",
  "src/components/ScheduledJobsPanel.tsx",
  "src/components/SecretBackendSection.tsx",
  "src/components/TelegramSection.tsx",
  "src/components/TerminalPanel.tsx",
  "src/components/ToolManagerSection.tsx",
  "src/components/onboarding/setupSteps.tsx",
  "src/lib/useChatThread.ts",
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const exactly = (paths: string[]) => new RegExp(`^(${paths.map(escapeRegExp).join("|")})$`);

/** Paths where a mistake leaks secrets, widens what the agent may do, or loses data. */
const HIGH_RISK_PATHS: PathRule[] = [
  {
    pattern: exactly(PRIVILEGED_FRONTEND_FILES),
    reason: "frontend calls that can leak a secret or run a command",
  },
  {
    pattern: exactly(PRIVILEGED_FRONTEND_IMPORTERS),
    reason: "frontend code that chooses what a privileged call does",
  },
  // The verifier must not be able to approve a change to itself.
  { pattern: /^\.github\//, reason: "CI or repo config" },
  { pattern: /^scripts\/verify\//, reason: "the verification layer itself" },
  // The merge reviewer's half: its prompt, its tools and signer, the grant that
  // lets it post, the fencing it reads through, and how its key reaches it.
  // An agent review can approve standard-risk changes, so these must be high.
  {
    pattern:
      /^(sidecar\/src\/verify\/|sidecar\/src\/agents\/(definitions\/merge-reviewer\.md|catalog\.ts|run\.ts|frontmatter\.ts|tools\.ts)$|sidecar\/src\/chat\/(destructiveTools|builtinTools|agent)\.ts$|sidecar\/src\/(lib\/fencing|github\/client|config)\.ts$|src-tauri\/src\/(sidecar|lib)\.rs$)/,
    reason: "the verification layer itself",
  },
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
    // Checked before the test-file exemption: the verifier's own tests are part of the verifier.
    const high = HIGH_RISK_PATHS.find((rule) => rule.pattern.test(path));
    if (high) {
      note("high", high.reason, path);
      continue;
    }
    const standard = STANDARD_RISK_PATHS.find((rule) => rule.pattern.test(path));
    if (standard && !isTestFile(path)) note("standard", standard.reason, path);
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
