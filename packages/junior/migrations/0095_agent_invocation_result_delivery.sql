ALTER TABLE "junior_agent_invocations" ADD COLUMN "kind" text GENERATED ALWAYS AS (CASE WHEN parent_tool_call_id IS NULL THEN 'own_work' ELSE 'parent_task' END) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_agent_invocations" ADD COLUMN "result_delivery" text;--> statement-breakpoint
-- The same mapping as `RESULT_DELIVERY_STATES` in
-- src/chat/agent-invocations/statuses.ts.
UPDATE "junior_agent_invocations" SET "result_delivery" = CASE "parent_mailbox_status"
  WHEN 'pending' THEN 'waiting'
  WHEN 'appended' THEN 'sent'
  WHEN 'skipped' THEN 'dropped'
  WHEN 'steered' THEN 'merged'
  WHEN 'replaced' THEN 'merged'
END
WHERE "parent_mailbox_status" IS NOT NULL;
