ALTER TABLE "junior_agent_invocations" ADD COLUMN "input_label" text;--> statement-breakpoint
ALTER TABLE "junior_agent_invocations" ADD COLUMN "report_log" jsonb;--> statement-breakpoint
-- This runtime sends a result before it writes the terminal row and never
-- reads `parent_mailbox_status`. Settle the rows that an older runtime left:
-- a later agent invocation already sent the result of a `replaced` row, and a
-- `pending` row is one whose send failed or crashed. Its result is not sent
-- again: that send would wake the parent with an old result.
UPDATE "junior_agent_invocations" SET "parent_mailbox_status" = 'steered'
WHERE "parent_mailbox_status" IN ('pending', 'replaced');
