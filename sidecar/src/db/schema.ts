import {
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

/** Embedding dimension used across the memory store and all embedders. */
export const EMBED_DIM = 768;

/**
 * Application schema for Yarvis. This holds *our* data — chat sessions/messages
 * and the daily/weekly work-tracking tasks. OpenMemory keeps its own separate
 * store for semantic memory.
 */

export const messageRole = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
  "tool",
]);

export const taskStatus = pgEnum("task_status", ["open", "done"]);
export const taskScope = pgEnum("task_scope", ["daily", "weekly"]);

export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: messageRole("role").notNull(),
  content: text("content").notNull(),
  toolCalls: jsonb("tool_calls"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const memories = pgTable("memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  content: text("content").notNull(),
  metadata: jsonb("metadata"),
  embedding: vector("embedding", { dimensions: EMBED_DIM }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const githubFilters = pgTable("github_filters", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  query: text("query").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("github_stars_pr_idx").on(t.owner, t.repo, t.number)],
);

/** Saved Omni layouts: a named json-render spec the user can reload later. */
export const omniLayouts = pgTable("omni_layouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  spec: jsonb("spec").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CustomProviderRow = typeof customProviders.$inferSelect;
export type NewCustomProviderRow = typeof customProviders.$inferInsert;

export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type MemoryRow = typeof memories.$inferSelect;
export type NewMemoryRow = typeof memories.$inferInsert;
export type GithubFilter = typeof githubFilters.$inferSelect;
export type GithubStar = typeof githubStars.$inferSelect;
export type OmniLayout = typeof omniLayouts.$inferSelect;
export type NewOmniLayout = typeof omniLayouts.$inferInsert;
export type GoogleToken = typeof googleTokens.$inferSelect;
export type NewGoogleToken = typeof googleTokens.$inferInsert;
