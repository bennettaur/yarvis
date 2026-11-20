ALTER TABLE "heads_down_passes" ADD COLUMN "routines_offered" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "heads_down_passes" ADD COLUMN "routines_done" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "heads_down_passes_started_idx" ON "heads_down_passes" USING btree ("started_at");