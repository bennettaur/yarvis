CREATE TYPE "public"."tool_policy" AS ENUM('always', 'search', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."tool_source" AS ENUM('builtin', 'mcp');--> statement-breakpoint
CREATE TABLE "agent_tools" (
	"id" text PRIMARY KEY NOT NULL,
	"source" "tool_source" NOT NULL,
	"server_id" uuid,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"input_schema" jsonb,
	"policy" "tool_policy" DEFAULT 'search' NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"transport" text NOT NULL,
	"url" text,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"header_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;