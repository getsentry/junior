-- A saved version now names the Automation creator, because creator
-- credentials belong to that person and a claim changes the creator. Before
-- claims, the creator never changed, so every saved version of an
-- Automation has its current creator.
-- junior:bounded-backfill: runs once over the saved versions of one install, which are few, and each row changes once.
UPDATE "junior_automation_versions"
SET "definition" = "junior_automation_versions"."definition" || jsonb_build_object(
  'createdBy',
  "junior_automations"."record"->'createdBy'
)
FROM "junior_automations"
WHERE "junior_automations"."id" = "junior_automation_versions"."automation_id"
  AND NOT ("junior_automation_versions"."definition" ? 'createdBy');
