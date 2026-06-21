CREATE TABLE "azure_devops_filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"project" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "azure_devops_stars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org" text NOT NULL,
	"project" text NOT NULL,
	"repo" text NOT NULL,
	"pr_id" integer NOT NULL,
	"title" text,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "azure_devops_stars_pr_idx" ON "azure_devops_stars" USING btree ("org","project","repo","pr_id");