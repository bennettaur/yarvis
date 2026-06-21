import {
  bigint,
  date,
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
