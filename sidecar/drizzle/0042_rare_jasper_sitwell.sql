CREATE TABLE "review_workspace_prs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"ref_key" text NOT NULL,
	"ref" jsonb NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"author" text,
	"head_ref" text,
	"base_ref" text,
	"color_index" integer NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"worktree_path" text NOT NULL,
	"worktree_status" text DEFAULT 'pending' NOT NULL,
	"head_sha" text,
	"base_sha" text,
	"merge_base_sha" text,
	"setup_consent" text,
	"setup_status" text,
	"setup_log" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_opened_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "review_workspace_prs" ADD CONSTRAINT "review_workspace_prs_workspace_id_review_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."review_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_workspace_prs_ws_ref_idx" ON "review_workspace_prs" USING btree ("workspace_id","ref_key");