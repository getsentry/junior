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

The observation and consolidation prompts adapt Lore's design with the
copyright holder's Apache-2.0 permission. The runtime and storage here belong
to Junior.
