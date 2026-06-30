CREATE TABLE "junior_memory_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_key" text,
	"content" text NOT NULL,
	"source_platform" text NOT NULL,
	"source_key" text NOT NULL,
	"idempotency_key" text,
	"observed_at_ms" bigint NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"expires_at_ms" bigint,
	"superseded_at_ms" bigint,
	"superseded_by_id" text,
	"archived_at_ms" bigint,
	"archive_reason" text,
	CONSTRAINT "junior_memory_memories_scope_check" CHECK ("junior_memory_memories"."scope" IN ('personal', 'conversation')),
	CONSTRAINT "junior_memory_memories_type_check" CHECK ("junior_memory_memories"."type" IN (
        'preference',
        'identity',
        'relationship',
        'knowledge',
        'context',
        'event',
        'task',
        'observation'
      )),
	CONSTRAINT "junior_memory_memories_subject_type_check" CHECK ("junior_memory_memories"."subject_type" IN ('user', 'conversation', 'general')),
	CONSTRAINT "junior_memory_memories_subject_key_check" CHECK (("junior_memory_memories"."subject_type" = 'general' AND "junior_memory_memories"."subject_key" IS NULL) OR ("junior_memory_memories"."subject_type" IN ('user', 'conversation') AND "junior_memory_memories"."subject_key" IS NOT NULL AND length("junior_memory_memories"."subject_key") > 0)),
	CONSTRAINT "junior_memory_memories_source_platform_check" CHECK ("junior_memory_memories"."source_platform" IN ('slack', 'local'))
);
--> statement-breakpoint
CREATE INDEX "junior_memory_memories_visible_idx" ON "junior_memory_memories" USING btree ("scope","scope_key","created_at_ms" DESC NULLS LAST,"id") WHERE "junior_memory_memories"."archived_at_ms" IS NULL AND "junior_memory_memories"."superseded_at_ms" IS NULL AND "junior_memory_memories"."superseded_by_id" IS NULL;--> statement-breakpoint
CREATE INDEX "junior_memory_memories_expiration_idx" ON "junior_memory_memories" USING btree ("expires_at_ms") WHERE "junior_memory_memories"."archived_at_ms" IS NULL AND "junior_memory_memories"."expires_at_ms" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_memory_memories_idempotency_idx" ON "junior_memory_memories" USING btree ("scope","scope_key","idempotency_key") WHERE "junior_memory_memories"."idempotency_key" IS NOT NULL;