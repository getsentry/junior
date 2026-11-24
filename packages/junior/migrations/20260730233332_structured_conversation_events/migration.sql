UPDATE "junior_conversation_events"
SET "type" = 'structured_event',
    "payload" = jsonb_set("payload", '{type}', '"structured_event"'::jsonb)
WHERE "type" IN ('plugin_event', 'native_event');
