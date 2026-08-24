CREATE TYPE "public"."agent_todo_status" AS ENUM('pending', 'in_progress', 'blocked', 'done', 'wont_do');--> statement-breakpoint
CREATE TYPE "public"."project_item_kind" AS ENUM('jira', 'github', 'pr', 'note');--> statement-breakpoint
CREATE TYPE "public"."project_item_priority" AS ENUM('urgent', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('active', 'paused', 'shipped', 'abandoned');--> statement-breakpoint
CREATE TABLE "agent_specialists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"prompt" text NOT NULL,
	"tool_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text,
	"model" text,
	"max_steps" integer DEFAULT 8 NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"details" text,
	"status" "agent_todo_status" DEFAULT 'pending' NOT NULL,
	"priority" "project_item_priority" DEFAULT 'medium' NOT NULL,
	"project_id" uuid,
	"due_at" timestamp with time zone,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cc_session_digests" (
	"session_id" text PRIMARY KEY NOT NULL,
	"project_dir" text NOT NULL,
	"source_mtime_ms" bigint NOT NULL,
	"memory_id" uuid,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"lease_until" timestamp with time zone,
	"cursor" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "project_item_kind" NOT NULL,
	"external_key" text,
	"title" text NOT NULL,
	"priority" "project_item_priority" DEFAULT 'medium' NOT NULL,
	"note" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "project_status" DEFAULT 'active' NOT NULL,
	"summary" text,
	"focus" text,
	"repo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestion_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref_key" text NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "kind" text DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source_ref" jsonb;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_todos" ADD CONSTRAINT "agent_todos_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cc_session_digests" ADD CONSTRAINT "cc_session_digests_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_items" ADD CONSTRAINT "project_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_specialists_name_unique_idx" ON "agent_specialists" USING btree ("name");--> statement-breakpoint
CREATE INDEX "agent_todos_status_idx" ON "agent_todos" USING btree ("status","priority");--> statement-breakpoint
CREATE INDEX "cc_session_digests_project_idx" ON "cc_session_digests" USING btree ("project_dir");--> statement-breakpoint
CREATE INDEX "project_items_project_idx" ON "project_items" USING btree ("project_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "project_items_external_unique_idx" ON "project_items" USING btree ("project_id","external_key") WHERE "project_items"."external_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_name_unique_idx" ON "projects" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "suggestion_dismissals_ref_unique_idx" ON "suggestion_dismissals" USING btree ("ref_key");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_occurred_idx" ON "events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "memories_kind_created_idx" ON "memories" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "memories_superseded_idx" ON "memories" USING btree ("superseded_at");--> statement-breakpoint
-- Memory kind used to live in the metadata blob; move the existing tags onto
-- the column so the new indexed reads see rows written before this migration.
UPDATE "memories" SET "kind" = "metadata"->>'type'
  WHERE "metadata"->>'type' IN ('note', 'doc');
