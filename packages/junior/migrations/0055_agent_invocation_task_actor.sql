ALTER TABLE "junior_agent_invocations" ADD COLUMN "task_actor_json" jsonb;--> statement-breakpoint
UPDATE "junior_agent_invocations" SET "task_actor_json" = "actor_json" WHERE NOT ("actor_json"->>'platform' = 'system' AND "actor_json"->>'name' = 'event');
