CREATE TYPE "public"."heads_down_answerer" AS ENUM('user', 'decision-model');--> statement-breakpoint
ALTER TABLE "heads_down_questions" ADD COLUMN "answered_by" "heads_down_answerer";