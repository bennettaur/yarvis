ALTER TABLE "heads_down_runs" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heads_down_runs" ADD COLUMN "stop_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_streams" ADD COLUMN "paused_at" timestamp with time zone;