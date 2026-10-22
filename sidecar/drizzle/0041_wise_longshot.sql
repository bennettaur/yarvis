CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"target_key" text NOT NULL,
	"status" text NOT NULL,
	"instance" text NOT NULL,
	"result" jsonb,
	"error" text,
	"cost_usd" double precision,
	"session_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "agent_runs_target_idx" ON "agent_runs" USING btree ("kind","target_key","started_at" DESC NULLS LAST);