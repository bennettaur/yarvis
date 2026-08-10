CREATE TABLE "pr_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref_key" text NOT NULL,
	"provider" text NOT NULL,
	"path" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"head_sha" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pr_insights_ref_idx" ON "pr_insights" USING btree ("ref_key","path");