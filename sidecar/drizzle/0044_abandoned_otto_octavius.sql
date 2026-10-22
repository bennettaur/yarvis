CREATE TABLE "mutation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pr_id" uuid NOT NULL,
	"ref_key" text NOT NULL,
	"head_sha" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"phase" text DEFAULT 'copying' NOT NULL,
	"instance" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plan_run_id" uuid,
	"explain_run_id" uuid,
	"plan" jsonb,
	"execution" jsonb,
	"summary" jsonb,
	"findings" jsonb,
	"error" text,
	"cost_usd" double precision,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mutation_runs" ADD CONSTRAINT "mutation_runs_workspace_id_review_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."review_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutation_runs" ADD CONSTRAINT "mutation_runs_pr_id_review_workspace_prs_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."review_workspace_prs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mutation_runs_pr_idx" ON "mutation_runs" USING btree ("pr_id","started_at" DESC NULLS LAST);