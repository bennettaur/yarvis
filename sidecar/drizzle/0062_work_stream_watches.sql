CREATE TYPE "public"."work_stream_kind" AS ENUM('work', 'watch');--> statement-breakpoint
ALTER TABLE "work_streams" ADD COLUMN "kind" "work_stream_kind" DEFAULT 'work' NOT NULL;--> statement-breakpoint
ALTER TABLE "work_streams" ADD COLUMN "watch_condition" text;--> statement-breakpoint
ALTER TABLE "work_streams" ADD COLUMN "watch_every_minutes" integer;--> statement-breakpoint
ALTER TABLE "work_streams" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_streams" ADD CONSTRAINT "work_streams_watch_fields_check" CHECK (("work_streams"."kind" = 'watch') = ("work_streams"."watch_condition" is not null and "work_streams"."watch_every_minutes" is not null and "work_streams"."expires_at" is not null));