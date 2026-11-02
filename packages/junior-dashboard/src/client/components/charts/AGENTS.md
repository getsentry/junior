# System cache reporting

- `cache-input.ts` owns the cache input calculation.
- `ConversationMetricDay` comes from stored Run metrics, not Sentry spans.
  Input, cached input, and cache-creation counters are disjoint: add them once
  for total input, without output. Do not use this transform for Sentry spans.
- Period shares use summed token counts, not the mean of bucket shares.
- A missing counter is not a zero. When an active bucket has no counter, omit
  its share and the whole-period share.
- Do not call these values a cache hit or failure rate. Field presence is not
  call-level coverage.
- The page time control selects the buckets for the chart and `CacheWrites`.
  No local time selector.
- Add a reporting contract before you add per-call filters or drilldowns.
