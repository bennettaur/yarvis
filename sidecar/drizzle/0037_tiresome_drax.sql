CREATE TYPE "public"."agent_question_status" AS ENUM('pending', 'answered', 'declined');--> statement-breakpoint
ALTER TYPE "public"."attention_kind" ADD VALUE 'question';--> statement-breakpoint
CREATE TABLE "agent_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_key" text,
	"workspace_id" uuid,
	"context" jsonb NOT NULL,
	"questions" jsonb NOT NULL,
	"status" "agent_question_status" DEFAULT 'pending' NOT NULL,
	"answers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_questions_session_status_idx" ON "agent_questions" USING btree ("session_key","status");