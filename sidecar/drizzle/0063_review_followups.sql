CREATE TABLE "pr_update_watches" (
	"ref_key" text PRIMARY KEY NOT NULL,
	"seen_head_sha" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"alerted_head_sha" text,
	"alerting_at" timestamp with time zone,
	"alerted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stall_reminders" (
	"item_key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"waiting_since" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"last_reminded_at" timestamp with time zone,
	"stopped_at" timestamp with time zone
);
