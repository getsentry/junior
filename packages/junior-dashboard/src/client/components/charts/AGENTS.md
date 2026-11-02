# System cache reporting

- `cache-input.ts` owns the cache input calculation.
- `ConversationMetricDay` comes from stored Run metrics, not Sentry spans.
  Its input, cached input, and cache-creation counters are disjoint. Add
  them once for total input. Do not include output. Never use this transform
  for Sentry span totals.
- Period shares use summed token counts, not the mean of bucket shares.
- A missing counter is not a zero. When an active bucket has no counter, omit
  its share and the whole-period share.
- Do not call these values a cache hit rate or a cache failure rate. Field
  presence is not call-level coverage.
- The page time control selects the buckets for the chart and `CacheWrites`.
  Do not add a local time selector.
- Add a reporting contract before you add per-call filters or drilldowns.
