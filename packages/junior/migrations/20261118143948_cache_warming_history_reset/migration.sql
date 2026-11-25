-- Days that a cache warming savings re-fill wrote before this release count
-- hits that no warmup reached and have no warmup cost. This deletes them, so
-- the System page does not show them as savings. A new re-fill rebuilds them.
-- junior:bounded-backfill: only the cache warming counters of days that a re-fill wrote, at most 90 days of a few rows per model; live recording does not write those days.
DELETE FROM "junior_stats"
WHERE "namespace" = 'cache_warming'
  AND "date" IN (
    SELECT "date" FROM "junior_stats"
    WHERE "namespace" = 'cache_warming' AND "metric" = 'history_days'
  );
