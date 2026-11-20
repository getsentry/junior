# Context compaction

A long Conversation keeps working when its history gets near the model's
context window. Junior replaces older history with a summary, and keeps the
prompt cache warm while a person is away, so that a return is fast and cheap.

## Intent

- A Turn does not stop because its history is too large. Compaction
  replaces older history with a summary before the history fills the
  context window.
- A summary is ready before a Turn needs it, so a Turn rarely waits for a
  summary call. Junior prepares it in the background from the background
  compaction mark, below the compaction threshold.
- In a Turn, history is replaced only at the compaction threshold. A
  replacement rewrites the cached prompt, so the next request writes the
  whole prefix to the cache again.
- An idle Conversation costs as little as possible for the return that
  comes next. Junior warms the cache only when the chance of a return pays
  for the warmup. With Claude Opus 5.5 prices for one million tokens (input
  $4, 5-minute cache write $5, cache read $0.20), a warmup reads the prefix
  and a warm return saves one write minus one read. So warming pays when
  more than 0.2 / (5 − 0.2), about 4%, of warmups reach a return.
- At or above the background compaction mark, an idle Conversation compacts
  instead of warming when that costs less. A returning Turn at that size is
  close to the compaction threshold, so it can compact in the Turn, and
  then pays for the full prefix and the compacted one. A compacted prefix of 120K tokens, against 360K, also
  makes each model call of the returning Turn about $0.05 cheaper to read.
- Junior accepts a quality cost for that saving. A Conversation that
  compacts on idle may not have compacted in its returning Turn. It then
  gets a summary in place of history that it would have kept, which can
  make an answer worse.

## Entry points

- Dashboard: the "context compacted" row in a Conversation transcript.
- Dashboard: Admin, Cache warming, to turn a paused provider back on.
- Deployment settings: `JUNIOR_CACHE_WARMING_ENABLED` and
  `JUNIOR_IDLE_COMPACTION_ENABLED`. Both are on by default.

## Rules

- Compaction on idle uses only a background summary that is ready. It
  makes no summary call. When no summary is ready, Junior warms as it does
  below the mark, and the next warmup checks again.
- Compaction on idle chooses at each warmup slot, when the cache is about
  to expire. With a ready summary, it takes the cheapest of three options
  for the full prefix P and the compacted prefix C. Each cost is the
  expected price of the warmups and of the first request of a return in
  the idle horizon, with the return chances and prices of the warmup rule:
  - Warm: a warmup reads P, and a return before the next slot reads P.
    The next slot chooses again.
  - Compact: a return writes C, and P gets no more warmups.
  - Stop: a return before the cache expires reads P. A later return
    writes P.
- For P = 360K and C = 120K tokens, a compacted return costs
  5 × 0.12 = $0.60, a warmup or a warm return 0.2 × 0.36 = $0.072, and a
  cold return of P $1.80. So warming wins only while a return is likely
  before the warmups cost more than the write of C. A Conversation with a
  likely quick return, such as one that waits for a child agent, warms
  first and compacts at a later slot. Stop wins only when the return
  likely comes before the current cache expires. On a tie, compaction
  wins, because a return after the horizon also writes less.
- After compaction on idle, Junior sends no warmups in that idle period.
  The compacted prefix is not in the cache, so its warmup would be a cache
  write. A return writes it once either way, so no return chance pays for
  that warmup.
- Compaction on idle never changes history under a running Turn. While a
  Run holds the Conversation, Junior warms instead.
- Compaction on idle runs only while cache warming is on.
  `JUNIOR_IDLE_COMPACTION_ENABLED=false` turns off only compaction on idle.

## Gaps

- An idle period whose request snapshot is too large to store gets no
  warmups, so it does not compact on idle either. This breaks "at or above
  the background compaction mark, an idle Conversation compacts instead of
  warming".
- The quality cost of compaction on idle is not measured, so nothing shows
  when it outweighs the saving. This breaks "Junior accepts a quality cost
  for that saving", which needs that cost to be known.
