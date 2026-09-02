CREATE TABLE "complexity_model_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"low_provider" text DEFAULT '' NOT NULL,
	"low_model" text DEFAULT '' NOT NULL,
	"medium_provider" text DEFAULT '' NOT NULL,
	"medium_model" text DEFAULT '' NOT NULL,
	"max_provider" text DEFAULT '' NOT NULL,
	"max_model" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
