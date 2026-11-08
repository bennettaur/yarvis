CREATE TABLE "heads_down_pr_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merged_at" timestamp with time zone,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "heads_down_pr_watches" ADD CONSTRAINT "heads_down_pr_watches_workspace_repo_id_workspace_repos_id_fk" FOREIGN KEY ("workspace_repo_id") REFERENCES "public"."workspace_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "heads_down_pr_watches_pr_idx" ON "heads_down_pr_watches" USING btree ("workspace_repo_id","pr_number");