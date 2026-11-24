ALTER TABLE "attention_items" ADD COLUMN "risk" text;--> statement-breakpoint
ALTER TABLE "review_preps" ADD COLUMN "risk" text;--> statement-breakpoint
ALTER TABLE "review_preps" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "review_preps_state_idx" ON "review_preps" USING btree ("state");