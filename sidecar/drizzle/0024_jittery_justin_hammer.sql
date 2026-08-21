ALTER TABLE "mcp_servers" ADD COLUMN "oauth" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_scope" text;