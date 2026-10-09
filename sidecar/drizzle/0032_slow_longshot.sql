ALTER TABLE "memories" ADD COLUMN "valid_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "confirmed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "confirm_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Existing memories held from when they were written and were last confirmed
-- then, not at migration time. A superseded one stopped holding when it was
-- corrected, which is what a correction records from here on.
UPDATE "memories" SET
  "valid_from" = "created_at",
  "confirmed_at" = "created_at",
  "valid_until" = "superseded_at";--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_valid_range" CHECK ("memories"."valid_until" is null or "memories"."valid_until" >= "memories"."valid_from");
