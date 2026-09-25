UPDATE "junior_conversation_events"
SET "type" = 'mcp_provider_connected_unowned'
WHERE "schema_version" = 1
  AND "type" = 'mcp_provider_connected'
  AND NOT (
    jsonb_typeof("payload") = 'object'
    AND "payload" ? 'credentialSubjectId'
  );
