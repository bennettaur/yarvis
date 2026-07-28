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
 * Optional provenance for a chat message. The in-app UI leaves it null; the
 * Telegram bot sets it on the user messages it persists so the chat history can
 * show that a message came from Telegram and which Telegram user sent it.
 */
export interface ChatMessageMetadata {
  source?: "telegram";
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const memories = pgTable("memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  content: text("content").notNull(),
  metadata: jsonb("metadata"),
  embedding: vector("embedding", { dimensions: EMBED_DIM }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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

/** Saved Omni layouts: a named json-render spec the user can reload later. */
export const omniLayouts = pgTable("omni_layouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  spec: jsonb("spec").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
 * User-configured LLM proxy providers (e.g. a litellm endpoint). Structural
 * data lives here; the secret values (API key, header values) stay in the
 * macOS Keychain and are injected into the sidecar at spawn time.
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
 * The active embeddings provider. Single-row model (like `google_tokens`): the
 * service keeps at most one row, the most recent. Structural data only — the
 * API key and any custom header values live in the macOS Keychain and reach the
 * sidecar via the `YARVIS_EMBEDDINGS_SECRETS` env var, like `custom_providers`.
 *
 * `dimensions` records the model's output size and must equal EMBED_DIM (the
 * column dimension); the embedder factory validates this and surfaces a clear
 * error otherwise. `apiKind` is "openai" today — both the user's proxy and a
 * local Ollama server speak the OpenAI-compatible embeddings API.
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

export type EmbeddingsConfigRow = typeof embeddingsConfig.$inferSelect;
export type NewEmbeddingsConfigRow = typeof embeddingsConfig.$inferInsert;

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
  | { type: "chat" }
  | { type: "pr"; owner: string; repo: string; number: number }
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
    // "ws-claude:<workspaceId>" for a Claude session; null for sourceless nudges.
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
 */
export const wipConfig = pgTable("wip_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  sources: jsonb("sources").$type<WipSourcesConfig>().notNull(),
  issueLabels: jsonb("issue_labels").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WipConfigRow = typeof wipConfig.$inferSelect;

export type CustomProviderRow = typeof customProviders.$inferSelect;
export type NewCustomProviderRow = typeof customProviders.$inferInsert;

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
export type IssueLink = typeof issueLinks.$inferSelect;
export type NewIssueLink = typeof issueLinks.$inferInsert;
export type IssueFilter = typeof issueFilters.$inferSelect;
export type NewIssueFilter = typeof issueFilters.$inferInsert;
export type IssueStar = typeof issueStars.$inferSelect;
export type NewIssueStar = typeof issueStars.$inferInsert;
