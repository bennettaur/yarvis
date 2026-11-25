CREATE TABLE "verification_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref_key" text NOT NULL,
	"run_id" uuid NOT NULL,
	"head_sha" text,
	"section" text NOT NULL,
	"kind" text NOT NULL,
	"item_key" text NOT NULL,
	"item" jsonb NOT NULL,
	"verdict" text,
	"rating" text,
	"reason" text,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verification_feedback_item_idx" ON "verification_feedback" USING btree ("ref_key","run_id","section","item_key");--> statement-breakpoint
CREATE INDEX "verification_feedback_updated_idx" ON "verification_feedback" USING btree ("updated_at" DESC NULLS LAST);