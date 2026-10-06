# System cache reporting

`InputCacheChart` owns the cache trend, summary, and largest writes.
`SystemActivity` selects its time buckets with the page reporting control.
`SystemMetricCharts` keeps spend and runtime beside the cache view.

## Input counters

`ConversationMetricDay` comes from stored Run metrics, not Sentry spans.
Its ordinary input, cached input, and cache-creation counters are disjoint.
Add these three counters once to get total input. Do not include output.
Sentry span input totals use a different rule and must not use this transform.

`cache-input.ts` owns this calculation. Period shares use summed token counts,
not the mean of bucket shares. A missing counter is not a reported zero.
If an active bucket lacks a counter, omit its share and the whole-period share.
Token mode can still show reported counts. Gray marks identify incomplete
buckets. Empty buckets do not lower shares.

Field presence is not call-level coverage. SQL sums can combine complete and
incomplete Runs in one bucket. Do not describe these values as a cache hit rate
or a cache failure rate.

## Investigation

`CacheWrites` lists the three largest write counts in the page time window.
The list and chart consume the same selected buckets. There is no local time
selector or comparison window. The list is collapsed until needed.

`useChartLayout` measures the available width. Charts keep a fixed, compact
height rather than growing taller on wide screens.

This report has no per-call model, release, environment, trace, or write-cost
fields. Add a reporting contract before adding those filters or drilldowns.
A large write alone cannot identify cache expiry, a cold start, or prefix loss.

The chart gallery includes a reuse drop and a missing counter. The System
browser scenario covers display modes and verifies that the page time control also filters the list.
