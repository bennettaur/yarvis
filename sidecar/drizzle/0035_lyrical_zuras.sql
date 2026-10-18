CREATE TYPE "public"."heads_down_question_kind" AS ENUM('question', 'approval');--> statement-breakpoint
CREATE TYPE "public"."heads_down_question_status" AS ENUM('open', 'answered', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."heads_down_run_status" AS ENUM('active', 'stopped');--> statement-breakpoint
CREATE TABLE "heads_down_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "heads_down_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"chat_session_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"notes" text,
	"sleep_minutes" integer,
	"sleep_reason" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "heads_down_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "heads_down_question_kind" NOT NULL,
	"stream_id" uuid,
	"question" text NOT NULL,
	"situation" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action" text,
	"tool_args" jsonb,
	"args_hash" text,
	"status" "heads_down_question_status" DEFAULT 'open' NOT NULL,
	"choice" text,
	"answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "heads_down_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"focus" text,
	"status" "heads_down_run_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "heads_down_passes" ADD CONSTRAINT "heads_down_passes_run_id_heads_down_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heads_down_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heads_down_passes" ADD CONSTRAINT "heads_down_passes_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heads_down_questions" ADD CONSTRAINT "heads_down_questions_stream_id_work_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."work_streams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "heads_down_messages_unseen_idx" ON "heads_down_messages" USING btree ("created_at") WHERE "heads_down_messages"."seen_at" is null;--> statement-breakpoint
CREATE INDEX "heads_down_passes_run_idx" ON "heads_down_passes" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE INDEX "heads_down_questions_status_idx" ON "heads_down_questions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "heads_down_questions_args_idx" ON "heads_down_questions" USING btree ("action","args_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "heads_down_runs_one_active_idx" ON "heads_down_runs" USING btree ("status") WHERE "heads_down_runs"."status" = 'active';