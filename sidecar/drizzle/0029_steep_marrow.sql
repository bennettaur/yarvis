DROP INDEX "memories_kind_created_idx";--> statement-breakpoint
DROP INDEX "memories_superseded_idx";--> statement-breakpoint
DROP INDEX "agent_specialists_name_unique_idx";--> statement-breakpoint
CREATE INDEX "memories_live_kind_created_idx" ON "memories" USING btree ("kind","created_at") WHERE "memories"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "memories_embedding_hnsw_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops) WHERE "memories"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_specialists_name_unique_idx" ON "agent_specialists" USING btree (lower("name"));