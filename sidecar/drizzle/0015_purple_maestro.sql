CREATE TYPE "public"."attention_kind" AS ENUM('permission', 'idle', 'completed', 'error', 'info');--> statement-breakpoint
CREATE TYPE "public"."attention_source" AS ENUM('claude-hook', 'chat-agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."attention_status" AS ENUM('pending', 'read', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TABLE "attention_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"source" "attention_source" NOT NULL,
	"session_key" text,
	"workspace_id" uuid,
	"kind" "attention_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"status" "attention_status" DEFAULT 'pending' NOT NULL,
	"nav_target" jsonb,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attention_status_seq_idx" ON "attention_items" USING btree ("status","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "attention_pending_dedupe_idx" ON "attention_items" USING btree ("session_key","kind") WHERE "attention_items"."status" = 'pending';