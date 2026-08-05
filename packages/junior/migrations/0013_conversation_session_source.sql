ALTER TABLE "junior_conversations" ADD COLUMN "source_json" jsonb;--> statement-breakpoint
-- Backfill session-stable Source locators for legacy root conversations.
UPDATE "junior_conversations" AS c
SET "source_json" = jsonb_build_object(
  'platform', 'slack',
  'type', CASE
    WHEN d."visibility" = 'public' THEN 'pub'
    ELSE 'priv'
  END,
  'teamId', d."provider_tenant_id",
  'channelId', d."provider_destination_id",
  'threadTs', split_part(c."conversation_id", ':', 3)
)
FROM "junior_destinations" AS d
WHERE c."source_json" IS NULL
  AND c."parent_conversation_id" IS NULL
  AND c."destination_id" = d."id"
  AND d."provider" = 'slack'
  AND split_part(c."conversation_id", ':', 2) = d."provider_destination_id"
  AND c."conversation_id" ~ '^slack:(C|G|D)[A-Z0-9]+:[0-9]+(\.[0-9]+)?$'
  AND d."provider_tenant_id" ~ '^T[A-Z0-9]+$'
  AND (
    d."visibility" IN ('public', 'private', 'direct')
    OR d."provider_destination_id" ~ '^(G|D)[A-Z0-9]+$'
  );--> statement-breakpoint
UPDATE "junior_conversations" AS c
SET "source_json" = jsonb_build_object(
  'platform', 'local',
  'type', 'priv',
  'conversationId', d."provider_destination_id"
)
FROM "junior_destinations" AS d
WHERE c."source_json" IS NULL
  AND c."parent_conversation_id" IS NULL
  AND c."destination_id" = d."id"
  AND d."provider" = 'local'
  AND c."conversation_id" = d."provider_destination_id"
  AND c."conversation_id" ~ '^local:[a-z0-9_-]+:[a-z0-9][a-z0-9_-]*$';
