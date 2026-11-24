CREATE TABLE "junior_automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"conversation_id" text,
	"status" text NOT NULL,
	"scheduled_for_ms" bigint,
	"attempt" integer,
	"claimed_at_ms" bigint,
	"dispatch_id" text,
	"started_at_ms" bigint,
	"completed_at_ms" bigint,
	"error_message" text,
	"result_message_ts" text,
	CONSTRAINT "junior_automation_runs_conversation_id_unique" UNIQUE("conversation_id"),
	CONSTRAINT "junior_automation_runs_status_check" CHECK ("junior_automation_runs"."status" in ('pending', 'running', 'completed', 'failed', 'blocked', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "junior_automation_runs" ADD CONSTRAINT "junior_automation_runs_automation_id_junior_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."junior_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "junior_automation_runs" ADD CONSTRAINT "junior_automation_runs_conversation_id_junior_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."junior_conversations"("conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "junior_automation_runs_automation_idx" ON "junior_automation_runs" USING btree ("automation_id","completed_at_ms");--> statement-breakpoint
CREATE INDEX "junior_automation_runs_completed_idx" ON "junior_automation_runs" USING btree ("completed_at_ms");--> statement-breakpoint
CREATE INDEX "junior_automation_runs_incomplete_idx" ON "junior_automation_runs" USING btree ("automation_id","scheduled_for_ms") WHERE "junior_automation_runs"."status" in ('pending', 'running');--> statement-breakpoint
-- Copy run history from both old tables. They stay for old workers during the
-- deploy. Copy junior_scheduler_runs first, because its rows have the full
-- run state. Then copy the junior_task_executions rows that are still missing.
-- A run keeps its Conversation link only when that Conversation exists. A run
-- of an Automation that no longer exists is not copied.
INSERT INTO "junior_automation_runs" (
	"id", "automation_id", "conversation_id", "status", "scheduled_for_ms",
	"attempt", "claimed_at_ms", "dispatch_id", "started_at_ms",
	"completed_at_ms", "error_message", "result_message_ts"
)
SELECT
	r."id",
	r."task_id",
	c."conversation_id",
	r."status",
	r."scheduled_for_ms",
	(r."record"->>'attempt')::integer,
	(r."record"->>'claimedAtMs')::bigint,
	r."record"->>'dispatchId',
	(r."record"->>'startedAtMs')::bigint,
	(r."record"->>'completedAtMs')::bigint,
	r."record"->>'errorMessage',
	r."record"->>'resultMessageTs'
FROM "junior_scheduler_runs" r
JOIN "junior_automations" a ON a."id" = r."task_id" AND a."kind" = 'scheduled'
LEFT JOIN "junior_conversations" c
	ON c."conversation_id" = 'agent-dispatch:' || (r."record"->>'dispatchId')
WHERE r."status" IN ('pending', 'running', 'completed', 'failed', 'blocked', 'skipped')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- An event run id is its dispatch id, so its Conversation id follows from it.
INSERT INTO "junior_automation_runs" (
	"id", "automation_id", "conversation_id", "status", "completed_at_ms"
)
SELECT
	e."execution_id",
	e."task_id",
	coalesce(e."conversation_id", c."conversation_id"),
	e."status",
	e."executed_at_ms"
FROM "junior_task_executions" e
JOIN "junior_automations" a ON a."id" = e."task_id" AND a."kind" = e."kind"
LEFT JOIN "junior_conversations" c
	ON e."kind" = 'event'
	AND c."conversation_id" = 'agent-dispatch:' || e."execution_id"
WHERE e."namespace" = 'junior'
ON CONFLICT DO NOTHING;
