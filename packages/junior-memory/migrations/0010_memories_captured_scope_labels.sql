-- Rewrite memories_captured history to the current v2 shape.
-- - personal -> private, conversation -> public
-- - version 1 rows become version 2
-- - identity keys stay aligned with the current min event version
-- No-op when core events are absent.
DO $$
BEGIN
  IF to_regclass('public.junior_conversation_events') IS NULL THEN
    RETURN;
  END IF;

  UPDATE junior_conversation_events AS event
  SET
    payload = jsonb_set(
      jsonb_set(
        event.payload,
        '{version}',
        '2'::jsonb
      ),
      '{content,memories}',
      (
        SELECT coalesce(
          jsonb_agg(
            CASE
              WHEN jsonb_typeof(memory.value) = 'object'
                AND memory.value->>'scope' = 'personal'
                THEN jsonb_set(memory.value, '{scope}', '"private"'::jsonb)
              WHEN jsonb_typeof(memory.value) = 'object'
                AND memory.value->>'scope' = 'conversation'
                THEN jsonb_set(memory.value, '{scope}', '"public"'::jsonb)
              ELSE memory.value
            END
            ORDER BY memory.ordinality
          ),
          '[]'::jsonb
        )
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(event.payload->'content'->'memories') = 'array'
              THEN event.payload->'content'->'memories'
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS memory(value, ordinality)
      )
    ),
    idempotency_key = CASE
      WHEN event.idempotency_key LIKE '%:event:memories_captured@1'
        AND NOT EXISTS (
          SELECT 1
          FROM junior_conversation_events AS other
          WHERE other.conversation_id = event.conversation_id
            AND other.idempotency_key = regexp_replace(
              event.idempotency_key,
              'event:memories_captured@1$',
              'event:memories_captured@2'
            )
        )
        THEN regexp_replace(
          event.idempotency_key,
          'event:memories_captured@1$',
          'event:memories_captured@2'
        )
      ELSE event.idempotency_key
    END
  WHERE event.type = 'structured_event'
    AND event.payload->>'namespace' = 'memory'
    AND event.payload->>'name' = 'memories_captured'
    AND (event.payload->>'version') IN ('1', '2')
    AND (
      (event.payload->>'version') = '1'
      OR (
        jsonb_typeof(event.payload->'content'->'memories') = 'array'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(event.payload->'content'->'memories') AS memory(value)
          WHERE memory.value->>'scope' IN ('personal', 'conversation')
        )
      )
      OR event.idempotency_key LIKE '%:event:memories_captured@1'
    );
END
$$;
