CREATE TYPE "public"."attention_category" AS ENUM('review', 'build', 'slack', 'general');--> statement-breakpoint
ALTER TYPE "public"."attention_kind" ADD VALUE 'action';--> statement-breakpoint
ALTER TYPE "public"."attention_kind" ADD VALUE 'message';--> statement-breakpoint
ALTER TABLE "attention_items" ADD COLUMN "category" "attention_category" DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "work_streams" ADD COLUMN "category" "attention_category";--> statement-breakpoint
-- The ADD VALUEs above can't be used later in this migration's transaction.
-- Existing items take the category their producer sets.
UPDATE "attention_items" SET "category" = 'review'
WHERE "nav_target" ->> 'type' = 'review-workspace'
	OR "session_key" LIKE 'pr-verification-queue:%'
	OR "session_key" LIKE 'pr-guide:%';--> statement-breakpoint
UPDATE "attention_items" SET "category" = 'build'
WHERE "category" = 'general' AND (
	"source" = 'claude-hook'
	OR "workspace_id" IS NOT NULL
	OR "session_key" LIKE 'claude-task:%'
	OR "session_key" LIKE 'heads-down-merge:%'
);--> statement-breakpoint
-- A guided review in progress is tracked on the WIP stream, not the bell.
UPDATE "attention_items"
SET "status" = 'resolved', "resolved_at" = now(), "updated_at" = now()
WHERE "session_key" LIKE 'pr-guide:%' AND "kind" = 'info' AND "status" = 'pending';
