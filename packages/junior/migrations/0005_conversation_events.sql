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
ALTER INDEX "junior_agent_steps_epoch_idx" RENAME TO "junior_conversation_events_history_version_idx";--> statement-breakpoint
ALTER TABLE "junior_conversation_events" RENAME COLUMN "context_epoch" TO "history_version";--> statement-breakpoint
ALTER TABLE "junior_conversation_events" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "junior_conversation_events" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "junior_conversation_events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "junior_conversation_events_idempotency_idx" ON "junior_conversation_events" USING btree ("conversation_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "junior_conversation_events_type_idx" ON "junior_conversation_events" USING btree ("conversation_id","type","seq");--> statement-breakpoint
CREATE INDEX "junior_conversation_events_message_search_idx" ON "junior_conversation_events" USING gin (to_tsvector('english', "payload"->>'text')) WHERE "type" = 'message';--> statement-breakpoint
UPDATE "junior_conversation_events"
SET
	"schema_version" = 1,
	"type" = 'agent_step',
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
UPDATE "junior_conversation_events"
SET "payload" = "payload" - 'args'
WHERE "type" = 'tool_execution_started'
	AND jsonb_typeof("payload") = 'object'
	AND "payload" ? 'args';--> statement-breakpoint
UPDATE "junior_conversation_events"
SET "type" = 'messages_summarized'
WHERE "type" = 'visible_context_compacted';--> statement-breakpoint
UPDATE "junior_conversation_events" AS snapshot
SET "payload" =
	(snapshot."payload" - 'compactions') ||
	jsonb_build_object(
		'historyFromSeq',
		coalesce((
			SELECT max(recorded."seq") + 1
			FROM "junior_conversation_events" AS recorded
			WHERE recorded."conversation_id" = snapshot."conversation_id"
				AND recorded."seq" < snapshot."seq"
				AND recorded."type" = 'message'
				AND EXISTS (
					SELECT 1
					FROM jsonb_array_elements(snapshot."payload"->'compactions') AS compaction,
						jsonb_array_elements_text(compaction->'coveredMessageIds') AS covered_id(value)
					WHERE covered_id.value = recorded."payload"->>'messageId'
				)
		), 0),
		'compactions',
		coalesce((
			SELECT jsonb_agg(
					(CASE
						WHEN EXISTS (
							SELECT 1
							FROM "junior_conversation_events" AS recorded
							WHERE recorded."conversation_id" = snapshot."conversation_id"
								AND recorded."type" = 'message'
						)
							THEN compaction - 'coveredMessageIds'
						ELSE compaction
					END) ||
					jsonb_build_object(
						'coveredMessageCount',
						jsonb_array_length(compaction->'coveredMessageIds')
				)
			)
			FROM jsonb_array_elements(snapshot."payload"->'compactions') AS compaction
		), '[]'::jsonb)
	)
WHERE snapshot."type" = 'messages_summarized';--> statement-breakpoint
