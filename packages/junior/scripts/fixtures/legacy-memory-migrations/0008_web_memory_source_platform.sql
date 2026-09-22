ALTER TABLE "junior_memory_memories" DROP CONSTRAINT "junior_memory_memories_source_platform_check";--> statement-breakpoint
ALTER TABLE "junior_memory_memories" ADD CONSTRAINT "junior_memory_memories_source_platform_check" CHECK ("junior_memory_memories"."source_platform" IN ('slack', 'local', 'web'));
