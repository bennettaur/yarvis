/**
 * The floor under a pull request's risk tier, worked out without a model: the
 * paths that are dangerous whatever the change does there, changes too big to
 * review well, and tripwires on the added lines for the things that make any
 * change risky (running a process, calling a privileged command, changing
 * what runs without asking). No area is presumed safe: a file starts low only
 * if none of these fire. Beyond that, how risky a change is depends on what
 * it does, which the `/verify-pr` skill assesses and signs into the report.
 * The tier a PR gets is the stricter of the two. Both the skill and the CI
 * gate compute this floor, and the gate trusts its own over the report's.
 */

export type Tier = "low" | "standard" | "high";

export interface ChangedFile {
  path: string;
  /** The old path of a renamed file, which is classified too. */
  previousPath?: string;
  /**
   * The file's added lines, for the tripwires; `null` when the diff was too
   * big for GitHub to send, which can't be scanned; left out to skip them.
   */
  addedText?: string | null;
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
    pattern: /^src-tauri\/src\/(mcp|custom_providers)\.rs$/,
    reason: "secrets, the control socket or shell access",
  },
  // The sidecar's one place that runs commands, the hooks that answer a
  // session's permission prompts, and the auto mode that skips asking.
  {
    pattern: /^sidecar\/src\/(workspaces\/(exec|claudeSettings)|chat\/toolReview)\.ts$/,
    reason: "what runs, or runs without asking",
  },
  {
    pattern:
      /^sidecar\/src\/(telegram\/(otpGate|totp)|github\/deviceFlow|mcp\/(oauth|connectionManager))\.ts$/,
    reason: "remote access, OAuth tokens or launching MCP servers",
  },
  // A definition is a system prompt and a tool list, so editing one changes
  // what an agent does and may do unasked.
  { pattern: /^sidecar\/src\/agents\/definitions\//, reason: "an agent's prompt or tools" },
  {
    pattern: /^scripts\/(browser\/host|compile-sidecar)\.ts$/,
    reason: "the browser's native host or the sidecar build",
  },
  {
    pattern: /^extension\/(page|background|site)\.js$|^extension\/manifest\.json$/,
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

interface Tripwire {
  tier: Tier;
  pattern: RegExp;
  reason: string;
}

/**
 * Patterns in added lines that make a change risky wherever it is. They are
 * crude on purpose: a false hit only sends a PR to a review, and a miss is
 * still covered by the report's assessment. Tests are skipped, since a test
 * may spawn a process or name a URL harmlessly.
 */
const TRIPWIRES: Tripwire[] = [
  {
    tier: "high",
    pattern:
      /\b(child_process|spawnSync|execSync|execFileSync|Bun\.spawn(Sync)?|Command::new)\b|std::process::Command/,
    reason: "runs a process",
  },
  {
    tier: "high",
    pattern:
      /\binvoke(?:<[^(]*>)?\(\s*["'](set_|delete_)\w*secret\w*["']|\binvoke(?:<[^(]*>)?\(\s*["'](set_secret_backend|set_agent|pty_write|pty_start_claude)["']/,
    reason: "calls a Tauri command that writes a secret or reaches a shell",
  },
  {
    tier: "high",
    pattern:
      /dangerously-skip-permissions|\beval\(|\bnew Function\(|\bunattended:|approval:\s*["']auto["']|ALWAYS_CONFIRM_BUILTIN_TOOLS|DESTRUCTIVE_BUILTIN_TOOLS/,
    reason: "changes what runs, or runs without asking",
  },
  {
    tier: "standard",
    pattern: /\bsecrets\??\.\w+|\bsecret_from_root\b|\bverifiedSigner\b/,
    reason: "reads a stored secret or a signature check",
  },
  {
    tier: "standard",
    pattern: /https?:\/\/(?!localhost\b|127\.0\.0\.1\b)[\w-]+\.[\w.-]+/,
    reason: "names an outside URL",
  },
  {
    tier: "standard",
    pattern:
      /\b(rmSync|unlinkSync|rmdirSync|remove_dir_all|remove_file)\b|\b(DELETE FROM|DROP TABLE|TRUNCATE)\b/,
    reason: "deletes files or data",
  },
];

/** Source the tripwires read; other files (images, JSON, docs) say nothing about behavior. */
const SCANNED = /\.(ts|tsx|js|mjs|cjs|rs|py|sh)$/;

const TIER_ORDER: Tier[] = ["low", "standard", "high"];

export function stricterTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

/** Only `*.test.ts(x)`: a `test/` directory also holds preloads and helpers, which are code. */
export function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
}

/** Agent definitions are markdown but behave like code, so their lines count. */
function isCode(path: string): boolean {
  if (/^sidecar\/src\/agents\/definitions\/.*\.md$/.test(path)) return true;
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

  for (const file of files) {
    if (file.addedText === undefined || isTestFile(file.path) || !SCANNED.test(file.path)) continue;
    if (file.addedText === null) {
      note("standard", "a diff too big to scan", file.path);
      continue;
    }
    for (const wire of TRIPWIRES) {
      if (wire.pattern.test(file.addedText)) note(wire.tier, wire.reason, file.path);
    }
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
