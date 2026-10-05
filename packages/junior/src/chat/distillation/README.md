# Conversation distillation

`task.ts` observes completed agent history after a Turn. It uses Luna and
stores short, dated observations as `distillation` events. It can merge older
segments into a structured summary. The task keeps recent segments as they
were recorded. It leaves images, unknown content parts, and oversized entries
in raw history rather than claim that it observed content it did not read. It
makes no model call on
the user's reply path.

Each event names its source sequence range and active history version. An
idempotency key prevents a retried task from adding the same segment twice.
History replacement changes the version, so old observations never enter the
new version by accident. Purging a Conversation removes its observations with
its other events. A worker cannot add observations after a purge.

`context.ts` checks the current routed model before the first model request of
a new Turn. It uses observations only when a cold replacement write and the
recorded worker cost save at least 20% against the current history's expected
cache reads. It uses recent model calls to bound that estimate. If the
replacement would exceed the model's input limit, it keeps the current path.
At the capacity trigger, an already prepared replacement may avoid another
summary call. All other capacity checks still use the existing path.

The worker makes the same price check before it writes observations. At the
current rates in `pi/client.ts` and the default 400k context cap, a Luna-to-Luna
Turn cannot pass this 20% check. Across the worker's eligible history sizes and
two to twelve expected calls, its best estimate saves 18%. This is an expected
price decision, not a worker failure. For an Opus history of 188,608 tokens and
an estimated 42,528-token replacement, eight expected calls save less than 1%.
Twelve expected calls save 26%. Recheck these figures when prices or limits
change. Neither estimate proves savings on a completed task.

The worker reads at most twelve complete 16k-token segments after a Turn.
Six segments cannot produce a priced replacement from one warm Opus Turn at
the current rates, even when the full eligible history passes the worker's
price check. Twelve segments cover a qualifying 180k-token history in one
bounded task. The next Turn still checks the cost of the actual replacement.

The direct Luna worker uses `cacheRetention: "none"`. OpenAI caches reusable
prefixes without explicit markers. Set `JUNIOR_CONTEXT_DISTILLATION_BATCH_ENABLED=true`
to send bounded observation segments through AI Gateway's Batch API. Junior
uses the same Gateway credential resolver for direct calls and batches. It
prefers Vercel OIDC and resolves the credential anew for each batch request.
The worker stores the batch reference in the Conversation before it schedules
a new signed task message. That message checks the batch every ten minutes.
It stops polling before the provider's 24-hour completion limit if results
remain unavailable and leaves the source history raw.
If history is replaced while a batch runs, the worker reads the old reference
only to record its known cost. It never uses those observations in the new
history.
The user reply does not wait for it. The worker matches results by request ID,
then writes all valid observations in source order or leaves the history raw.
Failed items do not cover source history. The batch has at most twelve requests
and stays below four megabytes of input. Older observations provide common
context to each request; later segments in the same batch do not see earlier
batch results. A direct consolidation call merges older results after the batch
finishes. Each new Turn keeps raw history until the results pass the price and
authority checks.

AI Gateway bills supported batches at a lower rate. The worker uses that rate
only while the batch setting is on. It reads billed generation cost when the
Gateway provides it. If only token usage is available, it records a discounted
estimate and marks that cost as estimated. Failed batches record known charges
separately from completed observations. Batches can take up to 24 hours.
AI Gateway rejects batches under zero data retention. If a batch endpoint is
unavailable, the worker checks direct-call cost again before a direct call.
Lore's one-hour Anthropic cache marker does not apply to Junior's OpenAI Luna
requests. OpenAI handles prefix caching implicitly.

The replacement is one durable `compaction` event. It keeps recent raw
messages, tool-call/result pairs, the current instruction and its author, and
the open plan. The observations sit in an escaped
`<thread-context authority="evidence-only">` block. They never grant action
authority. The replacement updates Pi history and its resume checkpoint
together. Numeric event details record whether price or capacity caused the
replacement. A failed or stale worker never changes model history.

`JUNIOR_CONTEXT_DISTILLATION_ENABLED` defaults to `false`. The flag controls
both background observations and their use on new Turns. Worker costs appear
under the `distillation` operation in Conversation auxiliary costs. Cache
token counts for assistant model calls remain separate. Evaluate completed
tasks, reply quality, latency, and both costs before wider use. No
cross-Conversation recall or Lore long-term memory is part of this feature.
The batch flag also defaults to `false`. It has no effect while distillation is
off. A direct-call eval cannot measure the delay or quality of batch results.

For a personal production trial, set `JUNIOR_CONTEXT_DISTILLATION_USER_IDS` to
the linked Junior user UUID and enable distillation in the same deployment.
The worker and new-Turn replacement require confirmed private visibility. They
also check that the current Actor and every authored instruction in active
history belong to that linked user. Unknown or unlinked authors block the
personal trial. When the user-ID list is empty, the
enabled flag keeps its deployment-wide meaning for controlled evals. Do not
enable it without the user-ID list for a personal production trial. The
Conversation reporting API records observer and Batch costs as auxiliary
operations. Add those costs to assistant usage for each completed task; the
personal spend total alone does not separate observer costs or priced history
replacements.

The observation and consolidation prompts adapt Lore's design with the
copyright holder's Apache-2.0 permission. The runtime and storage here belong
to Junior.
