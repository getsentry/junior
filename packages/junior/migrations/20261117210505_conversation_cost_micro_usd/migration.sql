-- Run cost metrics move to whole micro-USD in the same double `value`, which
-- holds every integer up to 2^53 exactly. The runtime before this release
-- writes `cost_usd` rows until its rollout ends; a later repair migration
-- converts those rows. This matches usdToMicroUsdSql.
-- junior:bounded-backfill: one cost row per Run, and the app rewrites the rows of a Run only while it runs, so only Runs in progress wait for this update.
UPDATE "junior_conversation_metrics"
SET "metric" = 'cost_micro_usd', "value" = round("value" * 1000000)
WHERE "metric" = 'cost_usd';
