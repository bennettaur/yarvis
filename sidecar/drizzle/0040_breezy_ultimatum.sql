CREATE TYPE "public"."alarm_source" AS ENUM('app', 'chat', 'heads-down');--> statement-breakpoint
CREATE TYPE "public"."alarm_status" AS ENUM('scheduled', 'fired', 'acknowledged', 'cancelled');--> statement-breakpoint
CREATE TABLE "alarms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"sound" boolean DEFAULT true NOT NULL,
	"meet_link" text,
	"status" "alarm_status" DEFAULT 'scheduled' NOT NULL,
	"source" "alarm_source" DEFAULT 'app' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "alarms_status_fire_at_idx" ON "alarms" USING btree ("status","fire_at");