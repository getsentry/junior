ALTER TABLE "junior_memory_memories" ADD COLUMN "conversation_id" text;
--> statement-breakpoint
UPDATE "junior_memory_memories"
SET "conversation_id" = "source_key"
WHERE "conversation_id" IS NULL
  AND "source_platform" IN ('web', 'local');
--> statement-breakpoint
UPDATE "junior_memory_memories"
SET "conversation_id" = 'slack:' || split_part("source_key", ':', 3) || ':' || split_part("source_key", ':', 4)
WHERE "conversation_id" IS NULL
  AND "source_platform" = 'slack';
