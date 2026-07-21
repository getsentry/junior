# Agent Runtime

The runtime prepares turns, advances durable agent state, handles continuation,
and coordinates provider delivery. `../agent/` owns the Pi execution loop; this
directory owns product orchestration around it.

## Turn Handling

- A turn may reply, intentionally remain silent, pause for authorization,
  cooperatively yield, or fail.
- Silence is explicit; absence of model text is not automatically a successful
  silent outcome.
- Every completed assistant message with visible text is delivered as its own
  destination reply. Thinking and raw tool-call parts remain internal.
- Assistant delivery is awaited before the run advances; tool-bearing messages
  are delivered before their tool batch executes.
- The runtime records each assistant message only after delivery succeeds.
- Resumed runs continue the same durable turn and must not repeat already
  committed side effects.

## Durable Continuation

- Conversation events append at safe boundaries with monotonic sequence numbers.
- Restoration reduces the current history version into Pi messages and derived
  runtime state.
- A timeout or soft execution limit yields only at a boundary where tool results
  and state updates are durable.
- Auth pauses persist the pending authorization state and end the live run;
  callbacks append new work and start a later run.
- Completion and delivery markers make retries idempotent.
- Canonical turn lifecycle uses stable conversation and turn IDs: input is
  durable before `turn_started`, and completion/failure is appended only at the
  owning delivery-and-persistence boundary. Competing terminal writes share
  one idempotency key, so the first committed outcome wins.
- Intentional silence is a `turn_completed` `no_reply` outcome and does not
  create a synthetic visible assistant message.
- Stable lifecycle keys make explicit retries idempotent; they do not cover
  process death between external delivery and persistence. Slack needs a
  durable delivery outbox/receipt reconciler before terminal events are
  crash-safe across that boundary.

## Prompt Ownership

- Core prompt text contains stable Junior behavior, not provider-specific setup.
- Runtime context supplies the active source, actor, destination, capabilities,
  artifacts, attachments, and execution constraints.
- Plugins contribute bounded prompt messages and tool descriptions through
  registered hooks.
- Skills provide task guidance after activation; they do not own runtime setup
  or credentials.
- Avoid repeating schemas, tool catalogs, policy prose, or implementation
  details already visible through structured surfaces.

## Compaction And Handoff

- Compaction replaces agent history. Its replacement history contains the
  retained user messages followed by a summary; later messages append normally.
  Visible conversation history remains unchanged.
- The replacement must retain unresolved work, durable facts, active artifacts,
  tool outcomes needed for continuation, and relevant actor/destination context.
- Model handoff is a permanent in-place transition recorded at a safe boundary.
  It does not fork the conversation or replay completed side effects.
- Restoration uses the model profile recorded by durable history, not
  process-local assumptions.
- Normal turn-record reads stay pinned to their checkpoint. Agent execution
  follows a newer committed compaction or handoff replacement and discards
  volatile context from the superseded history.

Representative integration coverage lives under
`packages/junior/tests/integration/runtime/`.
