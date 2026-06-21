CREATE TABLE "telegram_chats" (
	"chat_id" bigint PRIMARY KEY NOT NULL,
	"active_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_active_session_id_chat_sessions_id_fk" FOREIGN KEY ("active_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;