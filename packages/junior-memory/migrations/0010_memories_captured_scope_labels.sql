-- Rewrite pre-rename memories_captured v2 scope labels in conversation history.
-- personal -> private, conversation -> public. No-op when core events are absent.
DO $$
BEGIN
  IF to_regclass('public.junior_conversation_events') IS NULL THEN
    RETURN;
  END IF;

  UPDATE junior_conversation_events AS event
  SET payload = jsonb_set(
    event.payload,
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
  )
  WHERE event.type = 'structured_event'
    AND event.payload->>'namespace' = 'memory'
    AND event.payload->>'name' = 'memories_captured'
    AND (event.payload->>'version') = '2'
    AND jsonb_typeof(event.payload->'content'->'memories') = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(event.payload->'content'->'memories') AS memory(value)
      WHERE memory.value->>'scope' IN ('personal', 'conversation')
    );
END
$$;
