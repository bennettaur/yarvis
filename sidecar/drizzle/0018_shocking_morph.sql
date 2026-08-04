CREATE TABLE "pr_guides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref_key" text NOT NULL,
	"provider" text NOT NULL,
	"title" text,
	"url" text,
	"head_sha" text NOT NULL,
	"steps" jsonb NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pr_guides_ref_idx" ON "pr_guides" USING btree ("ref_key");