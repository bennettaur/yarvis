CREATE TABLE "chat_scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"origin" text DEFAULT 'chat' NOT NULL,
	"provider" text,
	"model" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"fired_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_scheduled_tasks" ADD CONSTRAINT "chat_scheduled_tasks_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_scheduled_tasks_due_idx" ON "chat_scheduled_tasks" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "chat_scheduled_tasks_session_idx" ON "chat_scheduled_tasks" USING btree ("session_id","status");