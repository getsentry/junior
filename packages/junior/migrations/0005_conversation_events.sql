ALTER TABLE "junior_agent_steps" RENAME TO "junior_conversation_events";--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conrelid = 'junior_conversation_events'::regclass
			AND conname = 'junior_agent_steps_conversation_id_seq_pk'
	) THEN
		ALTER TABLE "junior_conversation_events"
			RENAME CONSTRAINT "junior_agent_steps_conversation_id_seq_pk"
			TO "junior_conversation_events_conversation_id_seq_pk";
	ELSIF EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conrelid = 'junior_conversation_events'::regclass
			AND conname = 'junior_agent_steps_pkey'
	) THEN
		ALTER TABLE "junior_conversation_events"
			RENAME CONSTRAINT "junior_agent_steps_pkey"
			TO "junior_conversation_events_conversation_id_seq_pk";
	ELSE
		RAISE EXCEPTION 'junior_agent_steps primary key constraint is missing';
	END IF;
END
$$;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conrelid = 'junior_conversation_events'::regclass
			AND conname = 'junior_agent_steps_conversation_id_junior_conversations_conversation_id_fk'
	) THEN
		ALTER TABLE "junior_conversation_events"
			RENAME CONSTRAINT "junior_agent_steps_conversation_id_junior_conversations_conversation_id_fk"
			TO "junior_conversation_events_conversation_id_junior_conversations_conversation_id_fk";
	ELSIF EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conrelid = 'junior_conversation_events'::regclass
			AND conname = 'junior_agent_steps_conversation_id_fkey'
	) THEN
		ALTER TABLE "junior_conversation_events"
			RENAME CONSTRAINT "junior_agent_steps_conversation_id_fkey"
			TO "junior_conversation_events_conversation_id_junior_conversations_conversation_id_fk";
	ELSE
		RAISE EXCEPTION 'junior_agent_steps conversation foreign key constraint is missing';
	END IF;
END
$$;--> statement-breakpoint
ALTER INDEX "junior_agent_steps_epoch_idx" RENAME TO "junior_conversation_events_epoch_idx";--> statement-breakpoint
ALTER TABLE "junior_conversation_events" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_conversation_events" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "junior_conversation_events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_conversation_events_idempotency_idx" ON "junior_conversation_events" USING btree ("conversation_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "junior_conversation_events_type_idx" ON "junior_conversation_events" USING btree ("conversation_id","type","seq");--> statement-breakpoint
UPDATE "junior_conversation_events"
SET
	"schema_version" = 1,
	"type" = 'message',
	"payload" = CASE
		WHEN jsonb_typeof("payload") = 'object'
			THEN "payload" - 'schemaVersion'
		ELSE "payload"
	END
WHERE "type" = 'pi_message';--> statement-breakpoint
UPDATE "junior_conversation_events"
SET "payload" = "payload" - 'historyMode'
WHERE "type" = 'subagent_started'
	AND jsonb_typeof("payload") = 'object'
	AND "payload" ? 'historyMode';--> statement-breakpoint
