CREATE TYPE "public"."tool_approval" AS ENUM('ask', 'auto');--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "approval" "tool_approval" DEFAULT 'ask' NOT NULL;