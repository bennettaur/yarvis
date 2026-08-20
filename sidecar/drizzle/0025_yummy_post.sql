CREATE TABLE "voice_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stt_provider" text DEFAULT '' NOT NULL,
	"stt_model" text DEFAULT '' NOT NULL,
	"stt_language" text DEFAULT '' NOT NULL,
	"tts_provider" text DEFAULT '' NOT NULL,
	"tts_model" text DEFAULT '' NOT NULL,
	"tts_voice" text DEFAULT '' NOT NULL,
	"tts_ref_audio" text DEFAULT '' NOT NULL,
	"tts_extras" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"speak_replies" boolean DEFAULT true NOT NULL,
	"hands_free" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
