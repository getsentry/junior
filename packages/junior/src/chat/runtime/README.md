# Agent Runtime

The runtime prepares turns, advances durable agent state, handles continuation,
and coordinates provider delivery. `../agent/` owns the Pi execution loop; this
directory owns product orchestration around it.

## Turn Handling

- A turn may reply, intentionally remain silent, pause for authorization,
  cooperatively yield, or fail.
- Silence is explicit; absence of model text is not automatically a successful
  silent outcome.
- Every completed tool-free assistant message with visible text is delivered as
  its own destination reply. Thinking, tool calls, and text emitted alongside
  tool calls remain internal.
- Assistant delivery is awaited before the run advances. Explicit progress uses
  the runtime status surface rather than tool-bearing assistant text.
- The runtime records each assistant message only after delivery succeeds.
- Resumed runs continue the same durable turn and must not repeat already
  committed side effects. An ambiguous external delivery may be repeated when
  the provider accepted it before the worker lost confirmation.

## Durable Continuation

- Conversation events append at safe boundaries with monotonic sequence numbers.
- Restoration reduces the current history version into Pi messages and derived
  runtime state.
- A timeout or soft execution limit yields only at a boundary where tool results
  and state updates are durable.
- Auth pauses persist the pending authorization state and end the live run;
  callbacks append new work and start a later run.
- Transient or ambiguous reply-delivery failures resume from the last safe
  transcript boundary and share the normal bounded continuation limit.
- Explicit provider rejections fail the turn instead of retrying.
- Canonical turn lifecycle uses stable conversation and turn IDs: input is
  durable before `turn_started`, and completion/failure is appended only at the
  owning delivery-and-persistence boundary. Competing terminal writes share
  one idempotency key, so the first committed outcome wins.
- Intentional silence is a `turn_completed` `no_reply` outcome and does not
  create a synthetic visible assistant message.
- Stable lifecycle keys make internal terminal writes idempotent. External
  delivery remains best-effort: process death after a provider accepts a reply
  can produce a duplicate when the turn recovers.

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

- The host profile registry maps stable names to models and may force a
  reasoning level. Only `standard` uses the turn router; named profiles start
  directly and can use `handoff` to switch to another named profile.
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
