ALTER TABLE "events" ADD COLUMN "external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "events_external_id_idx" ON "events" USING btree ("external_id");