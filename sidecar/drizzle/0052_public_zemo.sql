CREATE TABLE "heads_down_feedback_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"pr_key" text NOT NULL,
	"workspace_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heads_down_feedback_handoffs" ADD CONSTRAINT "heads_down_feedback_handoffs_run_id_heads_down_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heads_down_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heads_down_feedback_handoffs" ADD CONSTRAINT "heads_down_feedback_handoffs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "heads_down_feedback_handoffs_run_pr_idx" ON "heads_down_feedback_handoffs" USING btree ("run_id","pr_key");