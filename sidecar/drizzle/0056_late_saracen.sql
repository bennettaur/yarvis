ALTER TABLE "workspace_repos" ADD COLUMN "prs_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_repos" ADD COLUMN "prs_poll_error" text;--> statement-breakpoint
-- Every cached row so far came from a search of the repo's own branch, so its
-- poll time is when that search last ran, and that branch is the PR's head.
UPDATE "workspace_repos" SET "prs_polled_at" = p."last_polled_at" FROM "workspace_repo_pr" p WHERE p."workspace_repo_id" = "workspace_repos"."id";--> statement-breakpoint
DELETE FROM "workspace_repo_pr" WHERE "pr_number" IS NULL;--> statement-breakpoint
DROP INDEX "workspace_repo_pr_wr_idx";--> statement-breakpoint
ALTER TABLE "workspace_repo_pr" ALTER COLUMN "pr_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_repo_pr" ADD COLUMN "head_branch" text;--> statement-breakpoint
ALTER TABLE "workspace_repo_pr" ADD COLUMN "dismissed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "workspace_repo_pr" SET "head_branch" = wr."branch" FROM "workspace_repos" wr WHERE wr."id" = "workspace_repo_pr"."workspace_repo_id";--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_repo_pr_wr_number_idx" ON "workspace_repo_pr" USING btree ("workspace_repo_id","pr_number");
