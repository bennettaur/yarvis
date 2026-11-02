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
  /** The file's removed lines, read like `addedText`. */
  removedText?: string | null;
  additions: number;
  deletions: number;
}

export interface TierResult {
  /** The floor once every file in `assess` has been assessed; see `floorTier`. */
  tier: Tier;
  reasons: string[];
  /**
   * Files whose risk depends on what the change does there, which a pattern
   * can't tell: a lint script and a script that downloads and runs a binary
   * look alike to it. The `/verify-pr` skill rates each one and signs the
   * paths it rated; any it didn't rate counts as high.
   */
  assess: { path: string; reason: string }[];
}

interface PathRule {
  pattern: RegExp;
  reason: string;
}

/** Paths where a mistake leaks secrets, widens what the agent may do, or loses data. */
const HIGH_RISK_PATHS: PathRule[] = [
  // The verifier must not be able to approve a change to itself, so its
  // workflows are high whatever the change, unlike the rest of `.github/`.
  { pattern: /^\.github\/workflows\/verify[^/]*\.ya?ml$/, reason: "the verification layer itself" },
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
  // The verify workflows install and run the default branch's code with the
  // merge credential, so what shapes that run is part of the verifier.
  {
    pattern: /^(bunfig\.toml|tsconfig\.json|\.npmrc)$|^\.github\/actions\//,
    reason: "what the verify workflows install and run with",
  },
  // Bun resolves a bare import through the nearest `node_modules`, and the
  // nearest tsconfig's `paths`, so one planted beside the verifier replaces
  // what it imports. Only the known workspaces keep their own.
  {
    pattern:
      /(^|\/)node_modules\/|^(?!sidecar\/|video\/)[^/]+\/(.+\/)?((tsconfig|jsconfig)[^/]*\.json|package\.json|bunfig\.toml|\.npmrc)$/,
    reason: "what the verify workflows install and run with",
  },
];

/**
 * Paths that run code or shape data, where a routine change is common and a
 * risky one looks the same to a pattern. They go to the skill's assessment
 * rather than straight to high.
 */
const ASSESSED_PATHS: PathRule[] = [
  { pattern: /^\.github\//, reason: "CI or repo config, which runs with the repo's secrets" },
  { pattern: /^lefthook\.yml$/, reason: "git hooks" },
  {
    pattern:
      /^(sidecar\/(bunfig\.toml|tsconfig[^/]*\.json)|tsconfig[^/]+\.json|mise\.toml|vite\.config\.ts|biome\.json)$/,
    reason: "build or test config, which runs code",
  },
  { pattern: /^sidecar\/src\/db\//, reason: "the database schema" },
];

/**
 * Added lines in a `.github/` file that reach a secret, a write token, a
 * trigger that runs with them, or the CI workflow's name, which
 * `verify-revert.yml` and the required checks go by. A change with any of
 * these is high without assessment: the merge credential is a repo secret
 * any workflow can read. Crude on purpose; a false hit only means a person looks.
 */
const PRIVILEGED_WORKFLOW_TEXT = new RegExp(
  [
    "\\bsecrets\\b",
    "YARVIS_",
    "create-github-app-token",
    ":\\s*[\"']?write\\b",
    "write-all",
    "GITHUB_ENV|GITHUB_PATH",
    "self-hosted",
    "^name:",
    "^\\s*(pull_request_target|workflow_run|issue_comment|push|schedule|workflow_dispatch|repository_dispatch|issues|workflow_call)\\s*:",
  ].join("|"),
  "m",
);

/**
 * Lifecycle hooks and settings that run code on `bun install`, including the
 * verify workflows'. A JSON escape (`\\u`) could spell any of these, so one
 * counts too.
 */
const INSTALL_HOOK_TEXT =
  /"(pre|post)?(install|prepare|publish|pack)"\s*:|"trustedDependencies"\s*:|"verify:[\w-]*"\s*:|\\u/;

const MIGRATION = /^sidecar\/drizzle\/[^/]+\.sql$/;
const MIGRATION_SNAPSHOT = /^sidecar\/drizzle\/meta\/\d+_snapshot\.json$/;
const MIGRATION_JOURNAL = "sidecar/drizzle/meta/_journal.json";

/**
 * The statements an additive migration may hold, in the exact shapes drizzle
 * generates: an allowlist, since every pattern of what not to allow has had a
 * way around it. Anything else, or anything odd inside these, is assessed.
 */
const NAME = '"\\w+"';
const TABLE = `("public"\\.)?${NAME}`;
// One word, or one of Postgres's few multi-word types: a free extra word
// would let `UNIQUE` or `CHECK` pass as part of the type.
const COLUMN_TYPE = `(${TABLE}|(timestamp|time) with(out)? time zone|double precision|character varying|[a-z][a-z0-9_]*)(\\(\\d+(,\\s*\\d+)?\\))?(\\[\\])?`;
// Values that run nothing against the rows already in the table.
const DEFAULT_VALUE = `'[^']*'(::[a-z]+(\\[\\])?)?|-?\\d+(\\.\\d+)?|true|false|null|now\\(\\)|gen_random_uuid\\(\\)`;
const INDEX_COLUMN = `${NAME}( [a-z_]+_ops)?( (asc|desc))?( nulls (first|last))?`;
const NULL_TEST = `(${NAME}\\.)?${NAME} is (not )?null`;
const ADDITIVE_STATEMENTS = [
  new RegExp(`^CREATE TYPE ${TABLE} AS ENUM\\(\\s*'[^']*'(\\s*,\\s*'[^']*')*\\s*\\)$`, "i"),
  new RegExp(
    `^ALTER TABLE ${TABLE} ADD COLUMN ${NAME} ${COLUMN_TYPE}( DEFAULT (${DEFAULT_VALUE}))?( NOT NULL)?$`,
    "i",
  ),
  new RegExp(
    `^CREATE INDEX( IF NOT EXISTS)? ${NAME} ON ${TABLE} USING [a-z]+ \\(${INDEX_COLUMN}(\\s*,\\s*${INDEX_COLUMN})*\\)( WHERE ${NULL_TEST}( and ${NULL_TEST})*)?$`,
    "i",
  ),
  /^CREATE EXTENSION IF NOT EXISTS "?vector"?$/i,
];
const CREATE_TABLE = new RegExp(`^CREATE TABLE( IF NOT EXISTS)? ${TABLE} \\(([\\s\\S]*)\\)$`, "i");
/** Inside a new table's columns: a copy of, or a link into, an existing table. */
const NOT_A_NEW_TABLE = /\b(AS|LIKE|INHERITS|PARTITION|SELECT)\b/i;

function isAdditiveStatement(statement: string): boolean {
  if (ADDITIVE_STATEMENTS.some((re) => re.test(statement))) {
    // A required column needs a default, or it fails on the rows already there.
    return (
      !/ ADD COLUMN /i.test(statement) ||
      !/ NOT NULL$/i.test(statement) ||
      / DEFAULT /i.test(statement)
    );
  }
  const table = statement.match(CREATE_TABLE);
  // A new table has no rows, so its columns' defaults and constraints can't
  // break anything; only a body that reaches another table can.
  return table !== null && !NOT_A_NEW_TABLE.test(table[3].replace(/"[^"]*"|'[^']*'/g, "x"));
}

/**
 * Whether a new migration only adds tables, columns, enum types or indexes.
 * An edit to an existing migration (any deleted line) or anything else, such
 * as a drop, a rename, a type change, a constraint or an `UPDATE`, needs
 * assessing. Drizzle sends each breakpoint-separated chunk as one query, so a
 * chunk with a `;` before its end, a comment or a `$` quote is refused
 * outright rather than parsed: any of them can hide a second statement.
 */
export function isAdditiveMigration(
  addedText: string | null | undefined,
  deletions: number,
): boolean {
  if (typeof addedText !== "string" || deletions > 0) return false;
  const chunks = addedText.split("--> statement-breakpoint").map((chunk) => chunk.trim());
  const statements = chunks.filter(Boolean).map((chunk) => chunk.replace(/;$/, "").trim());
  return (
    statements.length > 0 &&
    statements.every(
      (statement) =>
        !/;|--|\/\*|\$/.test(statement) && isAdditiveStatement(statement.replace(/\s+/g, " ")),
    )
  );
}

/**
 * Whether a journal edit only appends entries for this PR's additive
 * migrations. Appending rewrites just the previous entry's closing brace, so
 * a removed line that is anything else edits an entry that already ran,
 * which can make drizzle run it again.
 */
function appendsAdditiveEntries(file: ChangedFile, additive: Set<string>): boolean {
  if (typeof file.addedText !== "string" || typeof file.removedText !== "string") return false;
  if (!file.removedText.split("\n").every((line) => /^\s*\}?\s*$/.test(line))) return false;
  const tags = [...file.addedText.matchAll(/"tag"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
  return tags.length > 0 && tags.every((tag) => additive.has(`sidecar/drizzle/${tag}.sql`));
}

/**
 * Dependency manifests and lockfiles. A change here is standard rather than
 * high: the `/verify-pr` skill analyses each added or bumped package, and its
 * assessment raises the tier when that turns up a real risk.
 */
const DEPENDENCY_FILE =
  /(^|\/)(package\.json|bun\.lock|Cargo\.toml|Cargo\.lock|pyproject\.toml|uv\.lock)$/;

export function isDependencyFile(path: string): boolean {
  return DEPENDENCY_FILE.test(path);
}

const LOCKFILE = /(^|\/)(bun\.lock|Cargo\.lock|uv\.lock)$/;

/**
 * The lines a manifest may gain and still be only a dependency change: a
 * name and a registry version, brackets, and the section headers that hold
 * them. Anything else in a manifest (a script, a lifecycle hook,
 * `trustedDependencies`, a `[patch]` section, a build script, a git or path
 * source) runs code or changes where it comes from, so it stays high.
 */
const PLAIN_MANIFEST_LINE = [
  /^\s*$/,
  /^\s*[{}[\]],?\s*$/,
  // package.json: "name": "^1.2.3"
  /^\s*"[@\w./-]+"\s*:\s*"[\^~]?\d[\w.+-]*"\s*,?\s*$/,
  // package.json: the start of a dependency section
  /^\s*"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{\s*$/,
  // Cargo.toml: name = "1.2" or name = { version = "1.2", features = [...] }
  /^\s*[\w-]+\s*=\s*"[\^~=]?\d[\w.+-]*"\s*$/,
  /^\s*[\w-]+\s*=\s*\{\s*version\s*=\s*"[^"]*"(\s*,\s*(features\s*=\s*\[[^\]]*\]|default-features\s*=\s*(true|false)|optional\s*=\s*(true|false)))*\s*\}\s*$/,
  /^\s*\[((target\.[^\]]+\.)?(dev-|build-)?dependencies)\]\s*$/,
  // pyproject.toml: "name>=1.2",
  /^\s*"[\w.-]+(\[[\w,.-]+\])?\s*([<>=!~]=?|===)\s*\d[^"@;]*"\s*,?\s*$/,
];

/** A package fetched from somewhere other than its registry, which a lockfile can name. */
const UNUSUAL_SOURCE =
  /git\+|"(git|github|file|link|workspace|npm):|@npm:|\{\s*(git|path)\s*=|"https?:\/\/(?!files\.pythonhosted\.org\/|pypi\.org\/)/;

/**
 * Whether a dependency file's added lines only add, remove or bump packages
 * from their registry. `undefined` text (no tripwires asked for) passes; a
 * manifest too big to scan doesn't, but a lockfile does, since a large bump
 * is normal there and the skill's supply-chain check reads it.
 */
function onlyRegistryPackages(path: string, addedText: string | null | undefined): boolean {
  if (addedText === undefined) return true;
  if (LOCKFILE.test(path)) return addedText === null || !UNUSUAL_SOURCE.test(addedText);
  if (addedText === null) return false;
  return addedText.split("\n").every((line) => PLAIN_MANIFEST_LINE.some((re) => re.test(line)));
}

/**
 * Past this size a reviewer, human or agent, starts missing things. Counted
 * on code only: lockfiles, tests and docs inflate the number without adding
 * risk. Size alone never makes a change high: that tier is for what a change
 * can reach, not how big it is.
 */
const STANDARD_SIZE_LINES = 300;

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
  const assess: TierResult["assess"] = [];
  // Counts as standard here; `floorTier` makes it high if it goes unassessed.
  const toAssess = (reason: string, path: string) => {
    assess.push({ path, reason });
    note("standard", reason, path);
  };

  const additiveMigrations = new Set(
    files
      .filter(
        (file) => MIGRATION.test(file.path) && isAdditiveMigration(file.addedText, file.deletions),
      )
      .map((file) => file.path),
  );
  for (const file of files) {
    for (const path of file.previousPath ? [file.path, file.previousPath] : [file.path]) {
      // Tests count too: the verifier's own tests are part of the verifier.
      const high = HIGH_RISK_PATHS.find((rule) => rule.pattern.test(path));
      const assessed = ASSESSED_PATHS.find((rule) => rule.pattern.test(path));
      // A rename's old path has no added text of its own, so it is judged
      // as if nothing could be read from it.
      const text = path === file.path ? file.addedText : null;
      if (high) note("high", high.reason, path);
      else if (path.startsWith(".github/") && text !== undefined) {
        if (text === null || PRIVILEGED_WORKFLOW_TEXT.test(text)) {
          note("high", "CI that reaches secrets, write tokens or privileged triggers", path);
        } else toAssess("CI or repo config, which runs with the repo's secrets", path);
      } else if (assessed) toAssess(assessed.reason, path);
      else if (MIGRATION_SNAPSHOT.test(path)) note("standard", "migration metadata", path);
      else if (
        path === MIGRATION_JOURNAL &&
        path === file.path &&
        appendsAdditiveEntries(file, additiveMigrations)
      ) {
        note("standard", "migration metadata", path);
      } else if (path === file.path && additiveMigrations.has(path)) {
        note("standard", "a migration that only adds", path);
      } else if (path.startsWith("sidecar/drizzle/")) {
        toAssess("a migration that changes or removes existing schema or data", path);
      } else if (!isDependencyFile(path)) continue;
      else if (
        /(^|\/)package\.json$/.test(path) &&
        (text === null || INSTALL_HOOK_TEXT.test(text ?? ""))
      ) {
        note("high", "an install hook or a verify script", path);
      } else if (LOCKFILE.test(path) && typeof text === "string" && UNUSUAL_SOURCE.test(text)) {
        note("high", "a package from outside its registry", path);
      } else if (onlyRegistryPackages(path, text)) note("standard", "dependencies", path);
      else toAssess("a dependency file change beyond registry versions", path);
    }
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
  if (codeLines > STANDARD_SIZE_LINES) note("standard", `${codeLines} changed lines of code`);

  const tier: Tier = byTier.high.size > 0 ? "high" : byTier.standard.size > 0 ? "standard" : "low";
  // Only the winning tier's reasons: the report says why it is high, not
  // every lower-tier reason that also fired.
  const reasons = [...byTier[tier]].map(([reason, paths]) => {
    if (paths.length === 0) return reason;
    return paths.length === 1 ? `${reason} (${paths[0]})` : `${reason} (${paths.length} files)`;
  });
  return { tier, reasons, assess };
}

/**
 * The floor once the report's assessment is in: high if any file that needed
 * assessing isn't among the paths the signed report says it assessed.
 */
export function floorTier(result: TierResult, assessedPaths: readonly string[]): Tier {
  const assessed = new Set(assessedPaths);
  return result.assess.every(({ path }) => assessed.has(path)) ? result.tier : "high";
}
