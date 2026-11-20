CREATE TABLE "pr_review_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref_key" text NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text,
	"merge_base_sha" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pr_review_marks_ref_idx" ON "pr_review_marks" USING btree ("ref_key","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_marks_provider_idx" ON "pr_review_marks" USING btree ("ref_key","head_sha") WHERE "pr_review_marks"."source" = 'provider';