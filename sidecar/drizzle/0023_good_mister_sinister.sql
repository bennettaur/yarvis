CREATE TABLE "workspace_review_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_repo_id" uuid NOT NULL,
	"path" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"commit_sha" text,
	"body" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_review_comments" ADD CONSTRAINT "workspace_review_comments_workspace_repo_id_workspace_repos_id_fk" FOREIGN KEY ("workspace_repo_id") REFERENCES "public"."workspace_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_review_comments_wr_path_idx" ON "workspace_review_comments" USING btree ("workspace_repo_id","path");