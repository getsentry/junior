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
  for the warmup ([Cache warming](./cache-warming.md)).
- At or above the background compaction mark, an idle Conversation compacts
  instead of warming when that costs less. A returning Turn at that size is
  close to the compaction threshold, so it can compact in the Turn, and
  then pays for the full prefix and the compacted one. A compacted prefix
  of 120K tokens, against 360K, also makes each model call of the returning
  Turn about $0.05 cheaper to read.
- Junior accepts a quality cost for that saving. A Conversation that
  compacts on idle may not have compacted in its returning Turn. It then
  gets a summary in place of history that it would have kept, which can
  make an answer worse. This is a good trade: the mark is 306K tokens for
  a 400K context window, and the Turn compacts at 360K anyway.

## Entry points

- Dashboard: the "context compacted" row in a Conversation transcript.
- Dashboard: Admin, Cache warming, to turn a paused provider back on.
- Deployment settings: `JUNIOR_CACHE_WARMING_ENABLED` and
  `JUNIOR_IDLE_COMPACTION_ENABLED`. Both are on by default.

## Rules

- Compaction on idle starts at the background compaction mark, 0.85 × the
  compaction threshold. The background summary uses the same mark, so the
  two cannot diverge.
- Compaction on idle uses only a background summary that is ready. It
  makes no summary call. When no summary is ready, Junior warms as it does
  below the mark, and the next warmup checks again.
- Compaction on idle chooses at each warmup slot, when the cache is about
  to expire. With a ready summary, it takes the cheapest of three options
  for the full prefix P and the compacted prefix C. Each cost is the
  expected price of the warmups and of the first request of a return in
  the idle horizon, with the return chances and prices of the warmup rule:
  - Warm: a warmup costs about 1.1 reads of P, and a return before the
    next slot reads P.
    The next slot chooses again.
  - Compact: a return writes C, and P gets no more warmups.
  - Stop: a return before the cache expires reads P. A later return
    writes P.
- Warming wins only while a return is likely before the warmups cost more
  than the write of C. A Conversation with a likely quick return, such as
  one that waits for a child agent, warms first and compacts at a later
  slot. Stop wins only when the return likely comes before the current
  cache expires. On a tie, compaction wins, because a return after the
  horizon also writes less.
- A slot that the timer floor covers warms, so the timer's Turn reads the
  cache. With too few gaps, the warmup rule does not warm, so a return
  writes P either way, and compaction wins.
- An idle period whose request snapshot is too large to store gets no
  warmups. At or above the background compaction mark, it still gets its
  first warmup slot, because compaction on idle needs no snapshot. That
  slot can only compact or stop, and it sends no warmup. Then the idle
  period stops.
- After compaction on idle, Junior sends no warmups in that idle period.
  The compacted prefix is not in the cache, so its warmup would be a cache
  write. A return writes it once either way, so no return chance pays for
  that warmup.
- Compaction on idle never changes history under a running Turn. While a
  Run holds the Conversation, Junior warms instead.
- Compaction on idle runs only while cache warming is on.
  `JUNIOR_IDLE_COMPACTION_ENABLED=false` turns off only compaction on idle.
