CREATE TABLE "workspace_agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_key" text NOT NULL,
	"claude_session_id" text NOT NULL,
	"pid" integer NOT NULL,
	"source" text,
	"end_reason" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspace_agent_sessions" ADD CONSTRAINT "workspace_agent_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_agent_sessions_key_session_idx" ON "workspace_agent_sessions" USING btree ("session_key","claude_session_id");--> statement-breakpoint
CREATE INDEX "workspace_agent_sessions_workspace_idx" ON "workspace_agent_sessions" USING btree ("workspace_id");