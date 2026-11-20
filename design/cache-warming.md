# Cache warming

When a Conversation goes idle, Junior keeps its prompt cache warm while a
return is likely. A person who comes back soon then pays for a cache read,
not for a new write of the full history.

## Intent

- Each warmup must pay for itself. Junior sends the next warmup only while
  the expected saved cache writes cost more than the warmup.
- The breakeven uses the measured cost of a warmup, about 1.1 cache reads of
  the prefix, because a warmup also pays for its output and the request
  overhead. On Anthropic Opus, a read costs $0.2/MTok, a warmup about
  $0.22/MTok, and a 5-minute write $5/MTok. So a warmup pays when the chance
  of a return in the next 255-second interval is at least 0.22/4.8, about
  4.6%.
- The chance of a return decides when warming stops. No fixed time decides
  it. A fixed warming time of 20, 30, 55, or 90 minutes saves less than this
  rule, and a longer fixed time saves less again.
- For most Conversations, the chance of a return per interval falls below
  breakeven after about 18 minutes. Late returns occur, but they are too
  rare to pay for warming every Conversation that long. So nearly all
  warming stops because a return is unlikely, and the 55-minute idle horizon
  rarely stops it.
- A return after warming stopped is the expected price of the stop rule. It
  is not a cache failure. Nearly every last warmup before such a return read
  the cache.
- The size of the prefix does not move the breakeven, because the warmup
  cost and the saved write both scale with it. Size matters only through the
  segment of the Conversation.
- Return chances come from a small set of segments: who started the Turn,
  how many Turns came before it, the work state, and what the idle period
  waits on. A finer rule by Conversation, Turn ending, and prefix size
  predicts returns no better, so the segments stay small.
- Junior uses the 5-minute cache with warmups. On Anthropic Opus, a 1-hour
  write costs $8/MTok. A 1-hour cache on every call costs more than it
  saves. One 1-hour write of the prefix when a Conversation goes idle costs
  $8/MTok, and an hour of 5-minute warmups costs about $2.6/MTok.

## Entry points

- Automatic: each idle Conversation with a large enough cached prefix. No
  person asks for it.
- Dashboard: System, Cache warming, for net savings, effectiveness, and
  warmup cost.
- Dashboard: Admin, Cache warming, to turn warming of a provider back on.
- `JUNIOR_CACHE_WARMING_ENABLED=false`, to turn warming off.

## Rules

- A warmup never changes a Conversation. It posts nothing and starts no
  Turn.
- The cost of each warmup counts as cost of its Conversation, also when
  nobody returns.
- Junior warms only models whose cache write costs more than a read.
- When many warmups of one provider miss the cache, Junior stops warming
  for that provider for a while, so a broken cache does not keep costing
  money.

## Gaps

- While an idle period waits on a child agent, the chance of a return per
  interval stays well above breakeven past the idle horizon: about 12% at
  31 to 52 minutes, and about 6.5% at 52 to 103 minutes. Warming still stops
  at the horizon. This breaks "the chance of a return decides when warming
  stops".
