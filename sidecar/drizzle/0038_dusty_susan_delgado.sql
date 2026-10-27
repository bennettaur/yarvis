CREATE TABLE "chat_check_backs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"prompt" text NOT NULL,
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
ALTER TABLE "chat_check_backs" ADD CONSTRAINT "chat_check_backs_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_check_backs_due_idx" ON "chat_check_backs" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "chat_check_backs_session_idx" ON "chat_check_backs" USING btree ("session_id","status");