import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import type { ReviewDecision } from "../pr/types.ts";

/**
 * Embedding dimension of the `memories.embedding` column. This is a fixed
 * column dimension: every stored vector must have exactly this many components,
 * and the active embedder's output dimension must match it. 1536 is the
 * truncation target for our primary embedders — gemini-embedding-* (Matryoshka
 * output_dimensionality) and Qwen3 via an OpenAI-compatible endpoint. Changing
 * it requires a migration that clears existing vectors and a re-embed pass,
 * since vectors of different dimensions (or from different models) can't be
 * compared.
 */
export const EMBED_DIM: number = 1536;

/**
 * Application schema for Yarvis. This holds *our* data — chat sessions/messages
 * and the daily/weekly work-tracking tasks. OpenMemory keeps its own separate
 * store for semantic memory.
 */

export const messageRole = pgEnum("message_role", ["user", "assistant", "system", "tool"]);

/**
 * Optional provenance for a chat message. The in-app chat leaves it null; the
 * Telegram bot sets it on the user messages it persists so the chat history can
 * show that a message came from Telegram and which Telegram user sent it, and
 * the Voice tab sets it so a turn the user *spoke* is distinguishable from one
 * they typed and read back.
 *
 * That distinction is load-bearing, not cosmetic: a spoken turn was never
 * proof-read, so `runAgentTurn` puts the destructive tools behind an explicit
 * confirmation for it.
 */
export interface ChatMessageMetadata {
  source?: "telegram" | "voice";
  telegramUserId?: number;
  telegramUsername?: string;
  telegramFirstName?: string;
}

export const taskStatus = pgEnum("task_status", ["open", "done"]);
export const taskScope = pgEnum("task_scope", ["daily", "weekly"]);

export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: messageRole("role").notNull(),
  content: text("content").notNull(),
  toolCalls: jsonb("tool_calls"),
  // Provenance for the message (e.g. that it arrived via Telegram). Null for
  // messages composed in the app.
  metadata: jsonb("metadata").$type<ChatMessageMetadata>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Maps a Telegram conversation to its active Yarvis chat session. The Telegram
 * bot drives the same chat engine as the in-app UI, so each Telegram chat needs
 * a stable pointer to "the session I'm currently talking to". Keyed by the
 * Telegram chat id (a 64-bit integer) so the mapping survives sidecar restarts,
 * which back the `/new-chat` and `/switch` commands. `activeSessionId` is null
 * until the first message mints a session, and is set null if its session is
 * deleted.
 */
export const telegramChats = pgTable("telegram_chats", {
  // Telegram chat ids are 64-bit (user ids already exceed int4 range, and
  // supergroup/channel ids are large negatives), so this must be bigint.
  chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
  activeSessionId: uuid("active_session_id").references(() => chatSessions.id, {
    onDelete: "set null",
  }),
  // Provider/model the chat replies with, chosen via /setmodel. Null means
  // "use the configured default" (the first available provider).
  provider: text("provider"),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  status: taskStatus("status").notNull().default("open"),
  scope: taskScope("scope").notNull(),
  targetDate: date("target_date"),
  notes: text("notes"),
  sourceSessionId: uuid("source_session_id").references(() => chatSessions.id, {
    onDelete: "set null",
  }),
  // Links a task to the workspace opened to complete it. Archiving that
  // workspace completes the task. One-directional: the workspace carries no
  // reverse column.
  workspaceId: uuid("workspace_id").references(() => workspaces.id, {
    onDelete: "set null",
  }),
  // Which project this task serves, when the user has named one. Deleting the
  // project leaves the task, since the work may still be worth doing.
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

/**
 * What a memory *is*, as a first-class column rather than a metadata tag: the
 * consolidation jobs, the recap, and the memory UI all filter by it, and a
 * jsonb probe can't be indexed for those reads. Kept as text with a TS union
 * (like `EVENT_TYPES`) so adding a kind is a code change, not a migration.
 *
 * `fact`/`preference` come from the user directly, `note` from take_note, `doc`
 * from an ingested document chunk, `activity-summary` and `day-summary` from the
 * event-consolidation jobs, `session-summary` from a Claude Code transcript
 * digest, `agent-feedback` from guidance about how an agent should behave,
 * `project` from a project's narrative state, and `decision` from a choice worth
 * keeping. A declined suggestion is not among them — those live in
 * `suggestion_dismissals`, because the suggester filters on an exact key.
 */
export const MEMORY_KINDS = [
  "fact",
  "preference",
  "note",
  "doc",
  "activity-summary",
  "day-summary",
  "session-summary",
  "agent-feedback",
  "project",
  "decision",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * Where a memory came from, so a summary can be traced back to the material it
 * was built from (and a re-run can tell an already-summarized session from a new
 * one). A discriminated union stored as jsonb, like `AttentionNavTarget`.
 */
export type MemorySourceRef =
  | { type: "events"; from: string; to: string; eventIds: string[] }
  | { type: "cc-session"; projectDir: string; sessionId: string }
  | { type: "chat"; sessionId: string }
  | { type: "project"; projectId: string }
  | { type: "pr"; provider: string; key: string }
  | { type: "issue"; provider: string; key: string };

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    content: text("content").notNull(),
    kind: text("kind").$type<MemoryKind>().notNull().default("fact"),
    metadata: jsonb("metadata"),
    sourceRef: jsonb("source_ref").$type<MemorySourceRef>(),
    embedding: vector("embedding", { dimensions: EMBED_DIM }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * A memory the user has since corrected keeps its row (the correction is
     * itself worth having a trail of) but drops out of recall, pointing at
     * whatever replaced it.
     */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededById: uuid("superseded_by_id"),
  },
  (t) => [
    // The memory UI and the recap read one kind, newest-first, and both exclude
    // superseded rows — so this is partial on that condition rather than carrying
    // a separate index on `superseded_at`, which would never be chosen (the
    // column is null for almost every row).
    index("memories_live_kind_created_idx")
      .on(t.kind, t.createdAt)
      .where(sql`${t.supersededAt} is null`),
    /**
     * Approximate-nearest-neighbour index for recall. Without it every search is
     * a sequential scan that detoasts a 6KB vector per row, and the
     * consolidation jobs add a summary per window per day — so the table grows
     * without a natural ceiling while the system prompt asks the agent to recall
     * before answering.
     *
     * Partial on the same condition as the read above, which keeps the candidate
     * set to the rows recall can actually return. Note the consequence of any ANN
     * index: a `kind` filter is applied *after* the candidate set is chosen, so a
     * narrow filter can return fewer rows than the limit asks for.
     */
    index("memories_embedding_hnsw_idx")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
      .where(sql`${t.supersededAt} is null`),
  ],
);

export const githubFilters = pgTable("github_filters", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  query: text("query").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const githubStars = pgTable(
  "github_stars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    title: text("title"),
    url: text("url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("github_stars_pr_idx").on(t.owner, t.repo, t.number)],
);

/**
 * Saved Azure DevOps PR searches. Unlike GitHub's free-text query, an Azure
 * search is structured: a scope ("mine" | "review") and an optional project to
 * narrow to.
 */
export const azureDevopsFilters = pgTable("azure_devops_filters", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  scope: text("scope").notNull(),
  project: text("project"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Starred Azure DevOps PRs, identified by org/project/repo/pull-request id. */
export const azureDevopsStars = pgTable(
  "azure_devops_stars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    org: text("org").notNull(),
    project: text("project").notNull(),
    repo: text("repo").notNull(),
    prId: integer("pr_id").notNull(),
    title: text("title"),
    url: text("url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("azure_devops_stars_pr_idx").on(t.org, t.project, t.repo, t.prId)],
);

/**
 * The clipboard book: snippets the user copies often enough to want a permanent
 * home (an identity id, a CLI command, a link). Rows are reachable from the
 * clipboard palette, which searches label, content, and tags.
 *
 * Not a secret store — `clipboard/screening.ts` screens writes and secrets
 * belong in the Keychain — so content is plain text like any other note.
 *
 * `useCount`/`lastUsedAt` back the palette's ordering, so what the user reaches
 * for most is what an empty search offers first. Clipboard *history* is
 * deliberately absent: it lives in memory in the Rust core and is never
 * persisted.
 */
export const clipboardEntries = pgTable(
  "clipboard_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull(),
    content: text("content").notNull(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /** Pinned entries sort above everything else regardless of use. */
    pinned: boolean("pinned").notNull().default(false),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The palette's default list is "pinned first, then most recently used".
  (t) => [index("clipboard_entries_ranking_idx").on(t.pinned, t.lastUsedAt)],
);

/** Saved Omni layouts: a named json-render spec the user can reload later. */
export const omniLayouts = pgTable("omni_layouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  spec: jsonb("spec").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What a step is for. A `walkthrough` step is code the reviewer is expected to
 * read; `data` and `tests` are files the agent checked over on their behalf and
 * reports on, so a schema or a test file does not cost a close read it rarely
 * repays.
 */
export type PrGuideStepKind = "walkthrough" | "data" | "tests";

/** What a flagged problem is about, so the reader can weigh it before opening it. */
export type PrGuideFindingKind =
  | "error-handling"
  | "stale-comment"
  | "test-gap"
  | "brittle-test"
  | "naming"
  | "convention"
  | "other";

/** Something the agent thinks is wrong with the code a step covers. */
export interface PrGuideFinding {
  kind: PrGuideFindingKind;
  path: string;
  /** Where the problem is; null when it is about the file as a whole. */
  startLine: number | null;
  note: string;
}

/** One stop on a guided review: what to look at, and why it comes here. */
export interface PrGuideStep {
  path: string;
  /** Right-side line range the step is about; null for a whole-file step. */
  startLine: number | null;
  endLine: number | null;
  /** A sentence or two on what this code does and why it is read at this point. */
  explanation: string;
  /** Longer background, shown only when the reader asks to expand the step. */
  context?: string;
  /** Absent on guides generated before steps carried a kind; read as a walkthrough. */
  kind?: PrGuideStepKind;
  /**
   * Further files this step accounts for, beyond `path` — a sanity check over
   * every test file in the change reports as one step, not as one per file.
   */
  covers?: string[];
  /** Problems worth the reviewer's attention in the files this step covers. */
  findings?: PrGuideFinding[];
}

/**
 * A generated reading order for a pull request, taking the reviewer from the
 * outside of the change inward — the request that arrives, then what handles
 * it, down to what it finally writes.
 *
 * Rows are stamped with the commit they were generated against. A guide
 * describes code at a point in time, so once the PR moves the guide is stale
 * rather than wrong, and the reviewer is shown that rather than being quietly
 * walked through line numbers that have shifted.
 *
 * At most one guide per pull request: regenerating replaces what is there, so
 * the unique index is on `refKey` alone and not on the commit as well.
 */
export const prGuides = pgTable(
  "pr_guides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Provider-neutral PR identity; matches the frontend's `refKey`. */
    refKey: text("ref_key").notNull(),
    provider: text("provider").notNull(),
    /** Where the guide points, for opening the PR from the attention stream. */
    title: text("title"),
    url: text("url"),
    headSha: text("head_sha").notNull(),
    steps: jsonb("steps").$type<PrGuideStep[]>().notNull(),
    /** How far the reviewer has read; an index into `steps`. */
    currentStep: integer("current_step").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Bumped on every progress update, so an abandoned guide can be swept. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("pr_guides_ref_idx").on(t.refKey)],
);

/**
 * An answer to a question the reviewer asked about specific lines, kept beside
 * the code it is about.
 *
 * These are the reviewer's own working notes rather than review feedback: most
 * questions during a review are the reader orienting themselves, not something
 * the author needs to see. So an insight stays local until explicitly posted to
 * the provider as a comment, and `postedAt` records when that happened.
 *
 * Like guides they carry the commit they were written against, so an insight
 * about code that has since moved is marked rather than silently re-pinned to
 * whatever now occupies those line numbers.
 */
export const prInsights = pgTable(
  "pr_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Provider-neutral PR identity; matches the frontend's `refKey`. */
    refKey: text("ref_key").notNull(),
    provider: text("provider").notNull(),
    path: text("path").notNull(),
    /** Right-side line range the question was asked about, inclusive. */
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    headSha: text("head_sha").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    /** Set once the insight has been posted to the provider as a comment. */
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The review view loads every insight for a PR at once and buckets them by
  // file, so the index leads with the PR and narrows by path.
  (t) => [index("pr_insights_ref_idx").on(t.refKey, t.path)],
);

/**
 * Google OAuth tokens for the calendar integration. Single-account model: the
 * service keeps at most one row (the most recent). The refresh token is only
 * returned by Google on first consent, so it is preserved across refreshes.
 */
export const googleTokens = pgTable("google_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  scope: text("scope"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * User-configured LLM proxy providers (e.g. a litellm endpoint).
 *
 * Legacy — superseded by the `customProviders` section of
 * `~/.yarvis/settings.json` (`sidecar/src/customProviders/service.ts`). Kept
 * only as the source `sidecar/src/settings/migrateStructuralConfig.ts` reads
 * from for its one-time copy; no application code writes here anymore.
 */
export const customProviders = pgTable("custom_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKind: text("api_kind").notNull(), // "openai" | "anthropic"
  models: jsonb("models").$type<string[]>().notNull().default([]),
  headerNames: jsonb("header_names").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The model catalogue for a provider, editable by the user.
 *
 * Every provider's models used to be a hardcoded list, which meant a model
 * released after the last build was unreachable and a model the account has no
 * access to still showed up. Rows here take over a provider's catalogue: while
 * a provider has none, the bundled defaults in `llm/catalog.ts` stand in, and
 * the first row saved for it replaces them wholesale.
 *
 * `capabilities` is what each surface filters on — chat pickers offer `chat`
 * models, the voice settings offer `stt`/`tts` — so a speech model can be
 * listed without becoming a choice for chat inference.
 *
 * `provider_id` matches `ProviderInfo.id`, so a `custom:<uuid>` provider can be
 * tagged here too; those rows are keyed by the same string the picker uses.
 *
 * Legacy — superseded by the `providerModels` section of
 * `~/.yarvis/settings.json` (`sidecar/src/llm/catalog.ts`). Kept only as the
 * source `sidecar/src/settings/migrateStructuralConfig.ts` reads from for its
 * one-time copy; no application code writes here anymore.
 */
export const providerModels = pgTable(
  "provider_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    /** Cleared to hide a model from every picker without losing its tags. */
    enabled: boolean("enabled").notNull().default(true),
    /** Ascending; ties broken by model id so ordering is stable. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("provider_models_provider_model_idx").on(t.providerId, t.modelId)],
);

/**
 * Workspaces — one or many repo worktrees pulled together in a folder to
 * complete a contextual task (e.g. changing an API in service A that service B
 * calls). The sidecar owns the git/filesystem work; these tables are the
 * source of truth for what exists on disk.
 */

export const workspaceStatus = pgEnum("workspace_status", [
  "creating", // worktrees being provisioned / setup scripts running
  "active", // ready for use
  "archiving", // worktree teardown in progress
  "archived",
  "error", // provisioning or archival failed partway
]);

/** Per-repo provisioning state within a workspace. */
export const workspaceRepoStatus = pgEnum("workspace_repo_status", [
  "pending", // row created, nothing done yet
  "provisioning", // fetch / worktree add / setup running
  "ready",
  "removed", // worktree torn down (archive)
  "error",
]);

/** Rolled-up CI state for a workspace repo's PR, for cheap list filtering. */
export const checkRollup = pgEnum("check_rollup", ["success", "failure", "pending", "none"]);

/** Registry of repos yarvis manages clones + worktrees for. */
export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(), // display name, e.g. "service-a"
    owner: text("owner").notNull(), // github owner, for PR lookups
    repo: text("repo").notNull(), // github repo name
    cloneUrl: text("clone_url").notNull(), // git remote (ssh or https)
    defaultBranch: text("default_branch"), // detected lazily; null until first provision
    primaryClonePath: text("primary_clone_path").notNull(), // absolute path to the primary clone
    setupScript: text("setup_script"), // shell, run in each worktree after creation
    runScript: text("run_script"), // long-lived service command, run in a terminal
    pullIssues: boolean("pull_issues").notNull().default(false), // include this repo in the Issues dashboard
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("repos_owner_repo_idx").on(t.owner, t.repo)],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(), // filesystem-safe; used in paths + branch names
    status: workspaceStatus("status").notNull().default("creating"),
    rootPath: text("root_path").notNull(), // absolute parent folder (terminal cwd)
    summary: text("summary"), // archival summary of what was done
    mergedPrUrl: text("merged_pr_url"), // archival: the landed PR
    error: text("error"), // last provisioning/archive error
    // What the first agent session should work on, for a workspace whose
    // session hasn't been handed it yet. Kicking off work is a multi-step
    // sequence (create → provision → write the brief file → launch the agent);
    // holding the brief here rather than in the UI is what lets the sequence
    // survive the user navigating away mid-provision and resume when they come
    // back. Cleared once the agent session is live. The column name is narrower
    // than what it holds; widening it would be a migration for no behaviour.
    pendingBrief: text("pending_issue_prompt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  // Active slugs are unique; archived ones free the name for reuse.
  (t) => [
    uniqueIndex("workspaces_slug_active_idx").on(t.slug).where(sql`${t.status} <> 'archived'`),
  ],
);

/** One row per repo worktree inside a workspace. */
export const workspaceRepos = pgTable(
  "workspace_repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "restrict" }), // don't orphan worktrees
    status: workspaceRepoStatus("status").notNull().default("pending"),
    branch: text("branch").notNull(), // resolved worktree branch name
    // When true, `branch` is a pre-existing branch checked out into the worktree
    // rather than a fresh branch cut from `baseBranch`.
    existingBranch: boolean("existing_branch").notNull().default(false),
    baseBranch: text("base_branch").notNull(), // default branch it was cut from
    worktreePath: text("worktree_path").notNull(), // absolute subfolder
    setupLog: text("setup_log"), // capped tail of the last setup run
    setupExitCode: integer("setup_exit_code"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspace_repos_ws_repo_idx").on(t.workspaceId, t.repoId)],
);

/** Background-poller cache of the PR + checks for each workspace repo (1:1). */
export const workspaceRepoPr = pgTable(
  "workspace_repo_pr",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceRepoId: uuid("workspace_repo_id")
      .notNull()
      .references(() => workspaceRepos.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number"), // null = no PR found yet
    prUrl: text("pr_url"),
    prState: text("pr_state"), // open | closed | merged
    isDraft: boolean("is_draft"),
    mergeable: text("mergeable"), // MERGEABLE | CONFLICTING | UNKNOWN
    // Null when unknown: no PR, not polled, or a provider that can't answer.
    reviewDecision: text("review_decision").$type<ReviewDecision>(),
    checkRollup: checkRollup("check_rollup").notNull().default("none"),
    checks: jsonb("checks").$type<{
      total: number;
      success: number;
      failure: number;
      pending: number;
    }>(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastError: text("last_error"), // poll failed but the row persists
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspace_repo_pr_wr_idx").on(t.workspaceRepoId)],
);

/**
 * Self-review comments left on a workspace's own diffs, before any PR exists.
 * They never leave the machine: the point is to review your own work without
 * publishing half-formed notes to a PR, then hand the collected text to the
 * agent. Anchored to the right-hand (new file) line range the way a PR review
 * comment is, plus the commit the worktree was on when the note was written so
 * a stale anchor is recognisable after further work lands.
 */
export const workspaceReviewComments = pgTable(
  "workspace_review_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceRepoId: uuid("workspace_repo_id")
      .notNull()
      .references(() => workspaceRepos.id, { onDelete: "cascade" }),
    path: text("path").notNull(), // worktree-relative path of the reviewed file
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(), // equal to startLine for a single line
    // Worktree HEAD when the comment was written. Null when the branch has no
    // commits yet, so the note is still recorded rather than refused.
    commitSha: text("commit_sha"),
    body: text("body").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }), // null = still open
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workspace_review_comments_wr_path_idx").on(t.workspaceRepoId, t.path)],
);

/**
 * Ticket-system integration (GitHub Issues today, JIRA later). These tables are
 * deliberately source-agnostic: a ticket is identified by (`provider`,
 * `sourceKey`, `externalId`) rather than GitHub-specific columns, so a second
 * provider slots in without a schema change. For GitHub, `sourceKey` is
 * "owner/repo" and `externalId` is the issue number as a string; for JIRA,
 * `sourceKey` would be the project key and `externalId` the issue key.
 *
 * Issue *content* (title/body/labels) is fetched live from the provider like PR
 * search — it is not cached here. Only local state lives in these tables:
 * the link to a workspace + the local lifecycle status, saved filters, stars.
 */

/** Local lifecycle status for a tracked issue, independent of the provider's own state. */
export const issueLocalStatus = pgEnum("issue_local_status", ["todo", "in_progress", "done"]);

/**
 * Links a tracked issue to the workspace opened to work on it, and records its
 * local lifecycle status. Created when "Start work" opens a workspace for an
 * issue. One row per issue (unique on provider/sourceKey/externalId); archiving
 * the linked workspace marks the issue `done`.
 */
export const issueLinks = pgTable(
  "issue_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(), // "github" | "jira"
    sourceKey: text("source_key").notNull(), // github: "owner/repo"; jira: project key
    externalId: text("external_id").notNull(), // github: issue number; jira: issue key
    title: text("title"),
    url: text("url"),
    localStatus: issueLocalStatus("local_status").notNull().default("todo"),
    // The workspace opened to work on this issue. Null if the workspace was
    // deleted; the link + status survive so the issue stays flagged.
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("issue_links_issue_idx").on(t.provider, t.sourceKey, t.externalId)],
);

/**
 * Saved issue searches. Provider-tagged free-text query (GitHub search syntax
 * today; JQL later), mirroring `github_filters` but source-agnostic.
 */
export const issueFilters = pgTable("issue_filters", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  query: text("query").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Starred issues, identified by the same source-agnostic triple. */
export const issueStars = pgTable(
  "issue_stars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    sourceKey: text("source_key").notNull(),
    externalId: text("external_id").notNull(),
    title: text("title"),
    url: text("url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("issue_stars_issue_idx").on(t.provider, t.sourceKey, t.externalId)],
);

/**
 * The speech backends every surface uses — the Voice controls in chat, and the
 * Telegram bot once it grows them (#226). It lives here rather than in the
 * frontend precisely because the bot runs in this process and has no way to
 * read a browser's localStorage. Single row, like `embeddings_config`.
 *
 * Credentials are not here: a Hugging Face token is a Keychain secret, and a
 * custom provider's key rides its own entry. This is the structural half only.
 *
 * Legacy — superseded by the `voiceConfig` section of
 * `~/.yarvis/settings.json` (`sidecar/src/voice/config.ts`). Kept only as the
 * source `sidecar/src/settings/migrateStructuralConfig.ts` reads from for its
 * one-time copy; no application code writes here anymore.
 */
export const voiceConfig = pgTable("voice_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  sttProvider: text("stt_provider").notNull().default(""),
  sttModel: text("stt_model").notNull().default(""),
  /** ISO-639-1 hint; blank lets the model detect the language. */
  sttLanguage: text("stt_language").notNull().default(""),
  ttsProvider: text("tts_provider").notNull().default(""),
  ttsModel: text("tts_model").notNull().default(""),
  ttsVoice: text("tts_voice").notNull().default(""),
  /**
   * Reference clip for a voice-cloning model, as a base64 audio data URI. Text
   * rather than bytea: it goes out as a JSON string field, so storing it
   * decoded would mean re-encoding on every request.
   */
  ttsRefAudio: text("tts_ref_audio").notNull().default(""),
  /** Extra body fields for the synthesis request, keyed by field name. */
  ttsExtras: jsonb("tts_extras")
    .$type<Record<string, string | number | boolean>>()
    .notNull()
    .default({}),
  /** Speak replies aloud by default on a surface that can. */
  speakReplies: boolean("speak_replies").notNull().default(true),
  /**
   * End a turn on silence and re-open the mic after the reply. Off by default:
   * with it on, anything audible in the room can become a turn the user never
   * addressed to the assistant.
   */
  handsFree: boolean("hands_free").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The active embeddings provider. Single-row model (like `google_tokens`): the
 * service keeps at most one row, the most recent. Structural data only — the
 * API key and any custom header values live in the macOS Keychain and reach the
 * sidecar via the `YARVIS_EMBEDDINGS_SECRETS` env var, like `custom_providers`.
 *
 * `dimensions` records the model's output size and must equal EMBED_DIM (the
 * column dimension); the embedder factory validates this and surfaces a clear
 * error otherwise. `apiKind` is "openai" today — both the user's proxy and a
 * local Ollama server speak the OpenAI-compatible embeddings API.
 *
 * Legacy — superseded by the `embeddingsConfig` section of
 * `~/.yarvis/settings.json` (`sidecar/src/memory/embeddingsConfig.ts`). Kept
 * only as the source `sidecar/src/settings/migrateStructuralConfig.ts` reads
 * from for its one-time copy; no application code writes here anymore.
 */
export const embeddingsConfig = pgTable("embeddings_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  baseUrl: text("base_url").notNull(),
  model: text("model").notNull(),
  apiKind: text("api_kind").notNull().default("openai"),
  dimensions: integer("dimensions").notNull(),
  headerNames: jsonb("header_names").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Connected MCP (Model Context Protocol) servers. Structural data only — like
 * `custom_providers`, any credentials (HTTP auth header values, stdio env-var
 * secrets) stay in the macOS Keychain and reach the sidecar via the
 * `YARVIS_MCP_SECRETS` env var on spawn.
 *
 * `transport` is "http" (Streamable HTTP / SSE, using `url` + `headerNames`) or
 * "stdio" (a local subprocess, using `command` + `args`).
 *
 * `oauth` opts an http server into the MCP authorization flow (discovery →
 * dynamic client registration → authorization code + PKCE) instead of a
 * hand-entered bearer header. `oauthScope` overrides the scopes requested at
 * registration and authorization; absent, the server's advertised scopes are
 * used. Both are inert for stdio, which has no HTTP layer to authorize.
 *
 * Legacy — superseded by the `mcpServers` section of
 * `~/.yarvis/settings.json` (`sidecar/src/mcp/service.ts`). Kept only as the
 * source `sidecar/src/settings/migrateStructuralConfig.ts` reads from for its
 * one-time copy; no application code writes here anymore. `agent_tools.serverId`
 * (below) correlates to an id in that settings.json section, not a row here.
 */
export const mcpServers = pgTable("mcp_servers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  transport: text("transport").notNull(), // "http" | "stdio"
  url: text("url"),
  command: text("command"),
  args: jsonb("args").$type<string[]>().notNull().default([]),
  headerNames: jsonb("header_names").$type<string[]>().notNull().default([]),
  oauth: boolean("oauth").notNull().default(false),
  oauthScope: text("oauth_scope"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const toolSource = pgEnum("tool_source", ["builtin", "mcp"]);
export const toolPolicy = pgEnum("tool_policy", ["always", "search", "disabled"]);

/**
 * The unified tool registry: one row per tool the agent can use, spanning both
 * the app's built-in tools (source "builtin") and tools discovered from
 * connected MCP servers (source "mcp"). Each tool's name + description is
 * embedded so the agent's `search_tools` tool can find relevant ones by vector
 * search; `policy` governs how a tool is exposed:
 *   - "always"   → always mounted (always in the model's context),
 *   - "search"   → discoverable via search and mounted on demand,
 *   - "disabled" → never registered with the model.
 *
 * `id` is a stable string key: "builtin:<name>" or "mcp:<serverId>:<toolName>".
 * `contentHash` lets a resync skip re-embedding tools whose name/description/
 * schema are unchanged.
 */
export const agentTools = pgTable("agent_tools", {
  id: text("id").primaryKey(),
  source: toolSource("source").notNull(),
  // Correlates to an id in `mcpServers` (now `~/.yarvis/settings.json`, not this
  // table) — a plain uuid rather than an FK, since the referenced row no longer
  // lives in Postgres. `mcp/service.ts`'s `deleteMcpServer` deletes these rows
  // explicitly, taking over what the FK's `onDelete: "cascade"` used to do.
  serverId: uuid("server_id"),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  inputSchema: jsonb("input_schema"),
  policy: toolPolicy("policy").notNull().default("search"),
  contentHash: text("content_hash").notNull(),
  embedding: vector("embedding", { dimensions: EMBED_DIM }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type McpServerRow = typeof mcpServers.$inferSelect;
export type NewMcpServerRow = typeof mcpServers.$inferInsert;
export type AgentToolRow = typeof agentTools.$inferSelect;
export type NewAgentToolRow = typeof agentTools.$inferInsert;

export type EmbeddingsConfigRow = typeof embeddingsConfig.$inferSelect;
export type NewEmbeddingsConfigRow = typeof embeddingsConfig.$inferInsert;

export type VoiceConfigRow = typeof voiceConfig.$inferSelect;
export type NewVoiceConfigRow = typeof voiceConfig.$inferInsert;

/**
 * A local, on-device log of meaningful actions (tasks added/completed, a chat
 * started, a PR viewed, an alarm created, …). Periodic reconciliation (a later
 * phase) turns unprocessed events into memories, so `processedAt` marks events
 * already folded in. `occurredAt` is when the action happened (may predate the
 * row, e.g. a backfilled calendar event); `createdAt` is when it was recorded.
 * Deliberately schema-light: `type` is a dotted string and `payload` is opaque
 * JSON, so new event kinds don't need a migration.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    source: text("source"),
    payload: jsonb("payload"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Reconciliation scans unprocessed events oldest-first.
    index("events_processed_occurred_idx").on(t.processedAt, t.occurredAt),
    index("events_type_idx").on(t.type),
    // The events browser pages the whole log newest-first, with no type filter.
    index("events_occurred_idx").on(t.occurredAt),
  ],
);

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;

/**
 * Where an attention item originates. `claude-hook` is a Yarvis-launched Claude
 * Code session signalling through a Claude Code hook; `chat-agent` is the in-app
 * chat/Omni agent's `request_attention`; `system` is reserved for future
 * producers (e.g. an MCP tool).
 */
export const attentionSource = pgEnum("attention_source", ["claude-hook", "chat-agent", "system"]);

/**
 * The nature of the signal. `permission`/`idle` mean a session is *blocked* and
 * cannot proceed without the user; `completed` means it finished; `error` a
 * failure; `info` a generic nudge (the chat agent's request_attention).
 */
export const attentionKind = pgEnum("attention_kind", [
  "permission",
  "idle",
  "completed",
  "error",
  "info",
]);

/**
 * Lifecycle of an attention item. `pending` is unread/unactioned (drives the
 * badge count + notification); `read` the user has seen it; `resolved` the
 * underlying need is gone (e.g. the session finished, superseding its own
 * waiting prompts); `dismissed` the user swiped it away.
 */
export const attentionStatus = pgEnum("attention_status", [
  "pending",
  "read",
  "resolved",
  "dismissed",
]);

/**
 * Where clicking an attention item should take the user. A discriminated union
 * stored as JSON so producers can address any in-app destination without a
 * schema change; the frontend maps each variant onto its navigation primitive.
 */
export type AttentionNavTarget =
  | { type: "workspace-claude"; workspaceId: string }
  | { type: "workspace"; workspaceId: string }
  /**
   * A specific terminal session (tab/pane), addressed by its PTY id. Carries the
   * workspace when the session belongs to one, so the frontend can open that
   * workspace before focusing the tab.
   */
  | { type: "terminal"; sessionKey: string; workspaceId?: string }
  | { type: "chat" }
  | { type: "pr"; owner: string; repo: string; number: number }
  // Azure PRs are addressed by project/repo/id rather than owner/repo/number,
  // so they get their own variant instead of being squeezed into the GitHub
  // shape — the organization comes from configuration on both sides.
  | { type: "azure-pr"; org: string; project: string; repo: string; prId: number }
  | { type: "issue"; provider: string; sourceKey: string; externalId: string }
  | { type: "task"; taskId: string };

/**
 * The attention stream: things that want the user's attention, most urgently a
 * Yarvis-launched Claude Code session that is blocked on a permission prompt or
 * idle waiting for input. Unlike `events` (an append-only trail folded into
 * memory), these rows are *mutable* — the user reads, resolves, or dismisses
 * them — so this is a distinct table rather than an overload of the event log.
 *
 * `seq` is a monotonic cursor that orders the stream newest-first. A partial
 * unique index on (`sessionKey`, `kind`) restricted to pending rows lets
 * ingestion coalesce a re-prompting session into one live item instead of
 * stacking duplicates.
 */
export const attentionItems = pgTable(
  "attention_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    source: attentionSource("source").notNull(),
    // The PTY id of the session that raised it ("ws-claude:<workspaceId>" for a
    // workspace's pinned Claude session, "<surface>/<tab>/<pane>" for a terminal
    // pane); null for sourceless nudges.
    sessionKey: text("session_key"),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    kind: attentionKind("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    status: attentionStatus("status").notNull().default("pending"),
    navTarget: jsonb("nav_target").$type<AttentionNavTarget>(),
    // Raw producer payload (e.g. the Claude hook stdin) kept for debugging + future use.
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    // The stream reads by status, ordered by the monotonic cursor.
    index("attention_status_seq_idx").on(t.status, t.seq),
    // At most one pending item per (session, kind), so a re-prompt coalesces.
    uniqueIndex("attention_pending_dedupe_idx")
      .on(t.sessionKey, t.kind)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export type AttentionItemRow = typeof attentionItems.$inferSelect;
export type NewAttentionItemRow = typeof attentionItems.$inferInsert;

/** Which work-in-progress sources are included in the roll-up. */
export interface WipSourcesConfig {
  myPrs: boolean;
  starredPrs: boolean;
  issues: boolean;
  tasks: boolean;
  workspaces: boolean;
}

/**
 * User configuration for the work-in-progress stream. Singleton (like
 * `embeddings_config` / `google_tokens`): the service keeps at most one row.
 * `sources` toggles each roll-up source on/off; `issueLabels` drives an extra
 * "labeled issues" source — open GitHub issues assigned to the user carrying any
 * of these labels, across the repos flagged for issue tracking.
 *
 * Legacy — superseded by the `wipConfig` section of `~/.yarvis/settings.json`
 * (`sidecar/src/wip/config.ts`). Kept only as the source
 * `sidecar/src/settings/migrateStructuralConfig.ts` reads from for its
 * one-time copy; no application code writes here anymore.
 */
export const wipConfig = pgTable("wip_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  sources: jsonb("sources").$type<WipSourcesConfig>().notNull(),
  issueLabels: jsonb("issue_labels").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WipConfigRow = typeof wipConfig.$inferSelect;

/**
 * User configuration for the GitHub PR dashboard. Singleton (like `wip_config`):
 * the service keeps at most one row.
 *
 * `reviewQuery` replaces the built-in "Needs review" search so the user can
 * decide what counts as needing their attention (team review requests, drafts
 * excluded, a specific org, …). `reviewingLookbackDays` bounds how far back the
 * "Reviewing" tab looks for PRs the user has touched — both in the local
 * `pr.viewed` event log and in GitHub's own record of their comments/reviews.
 *
 * Legacy — superseded by the `githubPrConfig` section of
 * `~/.yarvis/settings.json` (`sidecar/src/github/config.ts`). Kept only as
 * the source `sidecar/src/settings/migrateStructuralConfig.ts` reads from for
 * its one-time copy; no application code writes here anymore.
 */
export const githubPrConfig = pgTable("github_pr_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  reviewQuery: text("review_query").notNull(),
  reviewingLookbackDays: integer("reviewing_lookback_days").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GithubPrConfigRow = typeof githubPrConfig.$inferSelect;

export type CustomProviderRow = typeof customProviders.$inferSelect;
export type NewCustomProviderRow = typeof customProviders.$inferInsert;

export type ProviderModelRow = typeof providerModels.$inferSelect;
export type NewProviderModelRow = typeof providerModels.$inferInsert;

export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type TelegramChat = typeof telegramChats.$inferSelect;
export type NewTelegramChat = typeof telegramChats.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type MemoryRow = typeof memories.$inferSelect;
export type NewMemoryRow = typeof memories.$inferInsert;
export type GithubFilter = typeof githubFilters.$inferSelect;
export type GithubStar = typeof githubStars.$inferSelect;
export type AzureDevopsFilter = typeof azureDevopsFilters.$inferSelect;
export type AzureDevopsStar = typeof azureDevopsStars.$inferSelect;
export type OmniLayout = typeof omniLayouts.$inferSelect;
export type NewOmniLayout = typeof omniLayouts.$inferInsert;
export type ClipboardEntry = typeof clipboardEntries.$inferSelect;
export type NewClipboardEntry = typeof clipboardEntries.$inferInsert;
export type GoogleToken = typeof googleTokens.$inferSelect;
export type NewGoogleToken = typeof googleTokens.$inferInsert;
export type Repo = typeof repos.$inferSelect;
export type NewRepo = typeof repos.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceRepo = typeof workspaceRepos.$inferSelect;
export type NewWorkspaceRepo = typeof workspaceRepos.$inferInsert;
export type WorkspaceRepoPr = typeof workspaceRepoPr.$inferSelect;
export type NewWorkspaceRepoPr = typeof workspaceRepoPr.$inferInsert;
export type WorkspaceReviewComment = typeof workspaceReviewComments.$inferSelect;
export type NewWorkspaceReviewComment = typeof workspaceReviewComments.$inferInsert;
export type IssueLink = typeof issueLinks.$inferSelect;
export type NewIssueLink = typeof issueLinks.$inferInsert;
export type IssueFilter = typeof issueFilters.$inferSelect;
export type NewIssueFilter = typeof issueFilters.$inferInsert;
export type IssueStar = typeof issueStars.$inferSelect;
export type NewIssueStar = typeof issueStars.$inferInsert;
export type PrGuideRow = typeof prGuides.$inferSelect;
export type NewPrGuideRow = typeof prGuides.$inferInsert;
export type PrInsightRow = typeof prInsights.$inferSelect;
export type NewPrInsightRow = typeof prInsights.$inferInsert;

/**
 * Lifecycle of a project the user is working on. `active` is the default and
 * what the weekly planning surfaces read; `paused` keeps it out of suggestions
 * without losing its history; `shipped`/`abandoned` are terminal.
 */
export const projectStatus = pgEnum("project_status", ["active", "paused", "shipped", "abandoned"]);

/**
 * A named body of work the user tells the assistant about ("the events
 * consolidation project"), so tickets, tasks, and memories can hang off one
 * durable id instead of being matched by title every turn. The narrative — what
 * was decided, what changed — lives in memory with a `project` source ref; this
 * table holds only the structured state the planner has to query.
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    status: projectStatus("status").notNull().default("active"),
    summary: text("summary"),
    /** What the user is trying to get done next, in their words. */
    focus: text("focus"),
    /** Repos the work lands in, by `repos.id`, for resolving workspaces. */
    repoIds: jsonb("repo_ids").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One project per name, matched case-insensitively: the agent resolves a
    // project from what the user said, and "Events Consolidation" and "events
    // consolidation" are the same project to them.
    uniqueIndex("projects_name_unique_idx").on(sql`lower(${t.name})`),
    index("projects_status_idx").on(t.status),
  ],
);

/** Where a tracked project item lives. `note` is an item with no external home. */
export const projectItemKind = pgEnum("project_item_kind", ["jira", "github", "pr", "note"]);

/** How urgent the user said an item is. Ordered highest-first when listed. */
export const projectItemPriority = pgEnum("project_item_priority", [
  "urgent",
  "high",
  "medium",
  "low",
]);

/**
 * A ticket (or a bare note) the user has told the assistant is part of a
 * project, with the priority they gave it. Deliberately a thin pointer: the
 * ticket's own state stays in JIRA/GitHub and is fetched when needed, because a
 * copy here would be stale the moment someone moves the card.
 */
export const projectItems = pgTable(
  "project_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: projectItemKind("kind").notNull(),
    /** Provider-native identifier: a JIRA key, `owner/repo#123`, or null for a note. */
    externalKey: text("external_key"),
    title: text("title").notNull(),
    priority: projectItemPriority("priority").notNull().default("medium"),
    /** Free-text status the user gave ("blocked on review"), not the provider's. */
    note: text("note"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("project_items_project_idx").on(t.projectId, t.priority),
    // The same ticket is tracked once per project; re-adding it updates instead.
    uniqueIndex("project_items_external_unique_idx")
      .on(t.projectId, t.externalKey)
      .where(sql`${t.externalKey} is not null`),
  ],
);

/**
 * Lifecycle of one of the assistant's *own* todos. Wider than `task_status`
 * because these are the agent's working state, and "I tried and it's blocked" or
 * "decided against" are outcomes it needs to record rather than silently drop.
 */
export const agentTodoStatus = pgEnum("agent_todo_status", [
  "pending",
  "in_progress",
  "blocked",
  "done",
  "wont_do",
]);

/** One appended note on an agent todo, with the instant it was written. */
export interface AgentTodoNote {
  at: string;
  text: string;
}

/**
 * The assistant's shadow todo list — what *it* has taken on, as opposed to
 * `tasks`, which is what the *user* intends to do. Separate because the two are
 * read by different surfaces and mixing them would put the agent's bookkeeping
 * into the user's daily list.
 *
 * These tools are deliberately not exposed over the MCP endpoint: this is the
 * in-app agent's own state, and a Claude Code session writing to it would be
 * one agent editing another's plan.
 */
export const agentTodos = pgTable(
  "agent_todos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    details: text("details"),
    status: agentTodoStatus("status").notNull().default("pending"),
    priority: projectItemPriority("priority").notNull().default("medium"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    /** Append-only progress log, so a todo carries why it stalled. */
    notes: jsonb("notes").$type<AgentTodoNote[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [index("agent_todos_status_idx").on(t.status, t.priority)],
);

/**
 * Bookkeeping for the background job scheduler: one row per job name, holding
 * its last run and a lease. The lease is what makes a job safe when several app
 * instances share one database — a tick claims it with a conditional update, so
 * only one process runs the job even though both are ticking.
 */
export const jobRuns = pgTable("job_runs", {
  name: text("name").primaryKey(),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  /** "ok" | "error" | "skipped" for the most recent completed run. */
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  /** Held while a run is in flight; a crashed run's lease simply expires. */
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  /** Job-defined progress marker (e.g. how far a transcript sweep got). */
  cursor: jsonb("cursor"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Which Claude Code transcripts have already been summarized into memory, keyed
 * by session id. `sourceMtimeMs` lets a session that was resumed and extended be
 * re-summarized, while an untouched one is skipped — the sweep runs nightly over
 * a directory that only grows.
 */
export const ccSessionDigests = pgTable(
  "cc_session_digests",
  {
    sessionId: text("session_id").primaryKey(),
    projectDir: text("project_dir").notNull(),
    sourceMtimeMs: bigint("source_mtime_ms", { mode: "number" }).notNull(),
    memoryId: uuid("memory_id").references(() => memories.id, { onDelete: "set null" }),
    /** Message count at digest time, so a resumed session's delta is visible. */
    entryCount: integer("entry_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cc_session_digests_project_idx").on(t.projectDir)],
);

/**
 * Configuration for the background jobs the user has to consent to.
 *
 * Singleton, like `wip_config`. The transcript digest is the only job that sends
 * data off the machine — it reads `~/.claude` transcripts, which routinely hold
 * pasted secrets, customer data and work for other clients, and hands them to
 * whichever LLM provider is configured. For a local-first app that is not
 * something to switch on by default, so it stays off until the user enables it
 * and names the project directories it may read.
 *
 * Legacy — superseded by the `jobConfig` section of `~/.yarvis/settings.json`
 * (`sidecar/src/jobs/config.ts`). Kept only as the source
 * `sidecar/src/settings/migrateStructuralConfig.ts` reads from for its
 * one-time copy; no application code writes here anymore.
 */
export const jobConfig = pgTable("job_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  ccDigestEnabled: boolean("cc_digest_enabled").notNull().default(false),
  /** Project directory names under `~/.claude/projects` the digest may read. */
  ccDigestProjectDirs: jsonb("cc_digest_project_dirs").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Suggestions the user has turned down, so "what should I work on next" stops
 * offering them. A structured row rather than a memory because the suggester
 * has to filter on it exactly, and a semantic match is the wrong instrument for
 * "is this specific PR dismissed". The reason is kept for when the agent has to
 * explain why something is absent, and `expiresAt` lets "not this week" differ
 * from "never".
 */
export const suggestionDismissals = pgTable(
  "suggestion_dismissals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stable key for the thing dismissed, e.g. `gh:owner/repo/12`, `todo:<id>`. */
    refKey: text("ref_key").notNull(),
    reason: text("reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("suggestion_dismissals_ref_unique_idx").on(t.refKey)],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectItem = typeof projectItems.$inferSelect;
export type NewProjectItem = typeof projectItems.$inferInsert;
export type AgentTodo = typeof agentTodos.$inferSelect;
export type NewAgentTodo = typeof agentTodos.$inferInsert;
export type JobRun = typeof jobRuns.$inferSelect;
export type NewJobRun = typeof jobRuns.$inferInsert;
export type CcSessionDigest = typeof ccSessionDigests.$inferSelect;
export type NewCcSessionDigest = typeof ccSessionDigests.$inferInsert;
export type JobConfigRow = typeof jobConfig.$inferSelect;
export type SuggestionDismissal = typeof suggestionDismissals.$inferSelect;
export type NewSuggestionDismissal = typeof suggestionDismissals.$inferInsert;
