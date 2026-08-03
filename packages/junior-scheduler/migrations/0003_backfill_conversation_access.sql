DO $$
BEGIN
  IF to_regclass('public.junior_destinations') IS NOT NULL THEN
    UPDATE "junior_scheduler_tasks" AS "task"
    SET "record" = jsonb_set(
      "task"."record",
      '{conversationAccess}',
      jsonb_build_object(
        'audience',
        CASE
          WHEN "task"."record"#>>'{conversationAccess,audience}' IN ('direct', 'group', 'channel')
            THEN "task"."record"#>>'{conversationAccess,audience}'
          WHEN "task"."record"#>>'{destination,channelId}' LIKE 'D%' THEN 'direct'
          WHEN "task"."record"#>>'{destination,channelId}' LIKE 'G%' THEN 'group'
          ELSE 'channel'
        END,
        'visibility',
        "destination"."visibility"
      ),
      true
    )
    FROM public."junior_destinations" AS "destination"
    WHERE COALESCE("task"."record"#>>'{conversationAccess,visibility}', 'unknown') = 'unknown'
      AND "destination"."provider" = 'slack'
      AND "destination"."provider_tenant_id" = "task"."team_id"
      AND "destination"."provider_destination_id" = "task"."record"#>>'{destination,channelId}'
      AND "destination"."visibility" IN ('public', 'private');
  END IF;
END $$;
--> statement-breakpoint
UPDATE "junior_scheduler_tasks" AS "task"
SET "record" = jsonb_set(
  "task"."record",
  '{conversationAccess}',
  jsonb_build_object(
    'audience',
    CASE
      WHEN "task"."record"#>>'{conversationAccess,audience}' IN ('direct', 'group', 'channel')
        THEN "task"."record"#>>'{conversationAccess,audience}'
      WHEN "task"."record"#>>'{destination,channelId}' LIKE 'D%' THEN 'direct'
      WHEN "task"."record"#>>'{destination,channelId}' LIKE 'G%' THEN 'group'
      ELSE 'channel'
    END,
    'visibility',
    'private'
  ),
  true
)
WHERE COALESCE("task"."record"#>>'{conversationAccess,visibility}', 'unknown') = 'unknown';
