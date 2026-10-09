ALTER TABLE "memories" ADD COLUMN "valid_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "confirmed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "confirm_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill from what the rows already record: a memory holds from when it was
-- written and counts as confirmed then, not at migration time.
UPDATE "memories" SET "valid_from" = "created_at", "confirmed_at" = "created_at";--> statement-breakpoint
-- A superseded memory stopped holding when it was corrected. `greatest` keeps
-- that from landing before `created_at` if the app's clock and the database's
-- disagree; it skips nulls, hence the filter.
UPDATE "memories" SET "valid_until" = greatest("superseded_at", "created_at")
  WHERE "superseded_at" IS NOT NULL;--> statement-breakpoint
-- A window summary holds from the start of the window it describes, which is
-- what the consolidation jobs record from here on.
UPDATE "memories" SET "valid_from" = least(("source_ref"->>'from')::timestamptz, "created_at")
  WHERE "kind" IN ('activity-summary', 'day-summary')
    AND "source_ref"->>'type' = 'events'
    AND "source_ref"->>'from' IS NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_valid_range" CHECK ("memories"."valid_until" is null or "memories"."valid_until" >= "memories"."valid_from");
