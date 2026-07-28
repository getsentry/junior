DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "junior_conversation_events"
		WHERE "schema_version" = 1
			AND "type" = 'agent_step'
			AND (
				jsonb_typeof("payload") IS DISTINCT FROM 'object'
				OR jsonb_typeof("payload"->'message') IS DISTINCT FROM 'object'
				OR "payload"->'message'->>'role' IS NULL
				OR "payload"->'message'->>'role' NOT IN ('user', 'assistant', 'toolResult')
			)
	) THEN
		RAISE EXCEPTION 'Cannot migrate malformed agent_step conversation events';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "junior_conversation_events" AS "event"
		WHERE "event"."schema_version" = 1
			AND "event"."type" IN ('compaction', 'handoff', 'rollback')
			AND (
				jsonb_typeof("event"."payload") IS DISTINCT FROM 'object'
				OR jsonb_typeof("event"."payload"->'replacementHistory') IS DISTINCT FROM 'array'
			)
	) THEN
		RAISE EXCEPTION 'Cannot migrate malformed conversation history replacements';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "junior_conversation_events" AS "event"
		CROSS JOIN LATERAL jsonb_array_elements(
			"event"."payload"->'replacementHistory'
		) AS "replacement"("item")
		WHERE "event"."schema_version" = 1
			AND "event"."type" IN ('compaction', 'handoff', 'rollback')
			AND (
				jsonb_typeof("replacement"."item") IS DISTINCT FROM 'object'
				OR (
					"replacement"."item" ? 'message'
					AND (
						jsonb_typeof("replacement"."item"->'message') IS DISTINCT FROM 'object'
						OR "replacement"."item"->'message'->>'role' IS NULL
						OR "replacement"."item"->'message'->>'role' NOT IN ('user', 'assistant', 'toolResult')
					)
				)
				OR (
					NOT ("replacement"."item" ? 'message')
					AND (
						jsonb_typeof("replacement"."item"->'item') IS DISTINCT FROM 'object'
						OR "replacement"."item"->'item'->>'type' IS NULL
						OR "replacement"."item"->'item'->>'type' NOT IN ('user_message', 'assistant_message', 'tool_result')
						OR "replacement"."item"->'item' ? 'role'
						OR (
							"replacement"."item"->'item'->>'type' = 'user_message'
							AND jsonb_typeof("replacement"."item"->'item'->'provenance') IS DISTINCT FROM 'object'
						)
					)
				)
			)
	) THEN
		RAISE EXCEPTION 'Cannot migrate malformed replacement history items';
	END IF;
END $$;
--> statement-breakpoint
UPDATE "junior_conversation_events"
SET
	"type" = CASE "payload"->'message'->>'role'
		WHEN 'user' THEN 'user_message'
		WHEN 'assistant' THEN 'assistant_message'
		WHEN 'toolResult' THEN 'tool_result'
	END,
	"payload" = CASE "payload"->'message'->>'role'
		WHEN 'user' THEN
			(("payload"->'message') - 'role')
			|| jsonb_build_object(
				'provenance',
				coalesce("payload"->'provenance', '{"authority":"context"}'::jsonb)
			)
		ELSE ("payload"->'message') - 'role'
	END
WHERE "schema_version" = 1
	AND "type" = 'agent_step';
--> statement-breakpoint
UPDATE "junior_conversation_events" AS "event"
SET "payload" = jsonb_set(
	"event"."payload",
	'{replacementHistory}',
	(
		SELECT coalesce(
			jsonb_agg(
				CASE
					WHEN "replacement"."item" ? 'message' THEN
						(("replacement"."item" - 'message') - 'provenance')
						|| jsonb_build_object(
							'item',
							CASE "replacement"."item"->'message'->>'role'
								WHEN 'user' THEN
									(("replacement"."item"->'message') - 'role')
									|| jsonb_build_object('type', 'user_message')
									|| jsonb_build_object(
										'provenance',
										coalesce(
											"replacement"."item"->'provenance',
											'{"authority":"context"}'::jsonb
										)
									)
								WHEN 'assistant' THEN
									(("replacement"."item"->'message') - 'role')
									|| jsonb_build_object('type', 'assistant_message')
								WHEN 'toolResult' THEN
									(("replacement"."item"->'message') - 'role')
									|| jsonb_build_object('type', 'tool_result')
							END
						)
					ELSE "replacement"."item"
				END
				ORDER BY "replacement"."position"
			),
			'[]'::jsonb
		)
		FROM jsonb_array_elements(
			"event"."payload"->'replacementHistory'
		) WITH ORDINALITY AS "replacement"("item", "position")
	)
)
WHERE "event"."schema_version" = 1
	AND "event"."type" IN ('compaction', 'handoff', 'rollback')
	AND EXISTS (
		SELECT 1
		FROM jsonb_array_elements(
			"event"."payload"->'replacementHistory'
		) AS "replacement"("item")
		WHERE "replacement"."item" ? 'message'
	);
--> statement-breakpoint
UPDATE "junior_conversation_events"
SET "type" = 'compaction'
WHERE "schema_version" = 1
	AND "type" = 'rollback';
