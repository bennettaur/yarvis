CREATE TABLE "review_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref_key" text NOT NULL,
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"label" text NOT NULL,
	"path" text NOT NULL,
	"line" integer NOT NULL,
	"head_sha" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"edited_body" text,
	"status" text DEFAULT 'open' NOT NULL,
	"outcome" text,
	"stale" boolean DEFAULT false NOT NULL,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "review_drafts_source_key_idx" ON "review_drafts" USING btree ("ref_key","source","source_key");