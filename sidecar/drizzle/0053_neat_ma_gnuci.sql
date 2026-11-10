CREATE TABLE "workspace_extra_worktrees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_repo_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"worktree_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_repo_pr" ADD COLUMN "head_sha" text;--> statement-breakpoint
ALTER TABLE "workspace_extra_worktrees" ADD CONSTRAINT "workspace_extra_worktrees_workspace_repo_id_workspace_repos_id_fk" FOREIGN KEY ("workspace_repo_id") REFERENCES "public"."workspace_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_extra_worktrees_path_idx" ON "workspace_extra_worktrees" USING btree ("workspace_repo_id","worktree_path");