CREATE TABLE "review_preps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref_key" text NOT NULL,
	"ref" jsonb NOT NULL,
	"workspace_id" uuid,
	"pr_id" uuid,
	"state" text DEFAULT 'queued' NOT NULL,
	"head_sha" text,
	"verdict" text,
	"note" text,
	"attention_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raised_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "review_workspaces" ADD COLUMN "opened_by" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_preps" ADD CONSTRAINT "review_preps_workspace_id_review_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."review_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_preps" ADD CONSTRAINT "review_preps_pr_id_review_workspace_prs_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."review_workspace_prs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_preps_ref_key_idx" ON "review_preps" USING btree ("ref_key");--> statement-breakpoint
CREATE INDEX "review_preps_workspace_idx" ON "review_preps" USING btree ("workspace_id");