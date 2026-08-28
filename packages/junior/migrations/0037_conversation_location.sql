ALTER TABLE "junior_conversations" ADD COLUMN "location_json" jsonb;
--> statement-breakpoint
UPDATE "junior_conversations" AS "conversation"
SET "location_json" =
  jsonb_build_object(
    'id', "location"."id",
    'provider', 'slack',
    'teamId', "location"."provider_tenant_id",
    'channelId', "location"."provider_destination_id"
  ) ||
  CASE
    WHEN "conversation"."source_json"->>'platform' = 'slack'
      AND "conversation"."source_json"->>'teamId' = "location"."provider_tenant_id"
      AND "conversation"."source_json"->>'channelId' = "location"."provider_destination_id"
      AND nullif(btrim("conversation"."source_json"->>'threadTs'), '') IS NOT NULL
    THEN jsonb_build_object(
      'threadTs', btrim("conversation"."source_json"->>'threadTs')
    )
    ELSE '{}'::jsonb
  END
FROM "junior_destinations" AS "location"
WHERE "conversation"."destination_id" = "location"."id"
  AND "location"."provider" = 'slack';
