CREATE TABLE "revert_investigations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"original_number" integer NOT NULL,
	"original_title" text NOT NULL,
	"original_url" text NOT NULL,
	"revert_kind" text NOT NULL,
	"revert_ref" text NOT NULL,
	"revert_title" text NOT NULL,
	"revert_url" text NOT NULL,
	"status" text DEFAULT 'detected' NOT NULL,
	"workspace_id" uuid,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ready_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "revert_investigations" ADD CONSTRAINT "revert_investigations_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revert_investigations" ADD CONSTRAINT "revert_investigations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "revert_investigations_original_idx" ON "revert_investigations" USING btree ("repo_id","original_number");