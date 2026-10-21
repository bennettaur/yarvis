CREATE TYPE "public"."work_stream_link_kind" AS ENUM('ticket', 'workspace', 'pr', 'message', 'review-request');--> statement-breakpoint
CREATE TYPE "public"."work_stream_status" AS ENUM('active', 'waiting-on-user', 'waiting-on-others', 'done', 'dropped');--> statement-breakpoint
CREATE TABLE "work_stream_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stream_id" uuid NOT NULL,
	"kind" "work_stream_link_kind" NOT NULL,
	"ref_key" text NOT NULL,
	"ref" jsonb NOT NULL,
	"title" text,
	"state" text,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"status" "work_stream_status" DEFAULT 'active' NOT NULL,
	"priority" "project_item_priority" DEFAULT 'medium' NOT NULL,
	"project_id" uuid,
	"next_action" text,
	"waiting_on" text,
	"wake_at" timestamp with time zone,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "work_stream_links" ADD CONSTRAINT "work_stream_links_stream_id_work_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."work_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_streams" ADD CONSTRAINT "work_streams_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_stream_links_ref_unique_idx" ON "work_stream_links" USING btree ("stream_id","ref_key");--> statement-breakpoint
CREATE INDEX "work_stream_links_ref_key_idx" ON "work_stream_links" USING btree ("ref_key");--> statement-breakpoint
CREATE INDEX "work_streams_status_idx" ON "work_streams" USING btree ("status","priority");