ALTER TABLE "junior_memory_memories" DROP CONSTRAINT "junior_memory_memories_type_check";--> statement-breakpoint
UPDATE "junior_memory_memories"
SET "type" = CASE
  WHEN "type" = 'task' THEN 'procedure'
  WHEN "type" IN ('identity', 'relationship', 'context', 'event', 'observation') THEN 'knowledge'
  ELSE "type"
END;--> statement-breakpoint
ALTER TABLE "junior_memory_memories" ADD CONSTRAINT "junior_memory_memories_kind_check" CHECK ("junior_memory_memories"."type" IN (
        'preference',
        'procedure',
        'knowledge'
      ));
