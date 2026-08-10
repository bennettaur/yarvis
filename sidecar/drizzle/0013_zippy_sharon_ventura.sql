CREATE TYPE "public"."issue_local_status" AS ENUM('todo', 'in_progress', 'done');--> statement-breakpoint
CREATE TABLE "issue_filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"source_key" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text,
	"url" text,
	"local_status" "issue_local_status" DEFAULT 'todo' NOT NULL,
	"workspace_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_stars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"source_key" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "pull_issues" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_links_issue_idx" ON "issue_links" USING btree ("provider","source_key","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_stars_issue_idx" ON "issue_stars" USING btree ("provider","source_key","external_id");