CREATE TYPE "public"."check_rollup" AS ENUM('success', 'failure', 'pending', 'none');--> statement-breakpoint
CREATE TYPE "public"."workspace_repo_status" AS ENUM('pending', 'provisioning', 'ready', 'removed', 'error');--> statement-breakpoint
CREATE TYPE "public"."workspace_status" AS ENUM('creating', 'active', 'archiving', 'archived', 'error');--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"clone_url" text NOT NULL,
	"default_branch" text,
	"primary_clone_path" text NOT NULL,
	"setup_script" text,
	"run_script" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_repo_pr" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_repo_id" uuid NOT NULL,
	"pr_number" integer,
	"pr_url" text,
	"pr_state" text,
	"is_draft" boolean,
	"mergeable" text,
	"check_rollup" "check_rollup" DEFAULT 'none' NOT NULL,
	"checks" jsonb,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"status" "workspace_repo_status" DEFAULT 'pending' NOT NULL,
	"branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"worktree_path" text NOT NULL,
	"setup_log" text,
	"setup_exit_code" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "workspace_status" DEFAULT 'creating' NOT NULL,
	"root_path" text NOT NULL,
	"summary" text,
	"merged_pr_url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_repo_pr" ADD CONSTRAINT "workspace_repo_pr_workspace_repo_id_workspace_repos_id_fk" FOREIGN KEY ("workspace_repo_id") REFERENCES "public"."workspace_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_repos" ADD CONSTRAINT "workspace_repos_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_repos" ADD CONSTRAINT "workspace_repos_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repos_owner_repo_idx" ON "repos" USING btree ("owner","repo");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_repo_pr_wr_idx" ON "workspace_repo_pr" USING btree ("workspace_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_repos_ws_repo_idx" ON "workspace_repos" USING btree ("workspace_id","repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_active_idx" ON "workspaces" USING btree ("slug") WHERE "workspaces"."status" <> 'archived';--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;