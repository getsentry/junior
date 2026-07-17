# Agent Runtime

The runtime prepares turns, advances durable agent state, handles continuation,
and produces a finalized delivery plan. `../agent/` owns the Pi execution loop;
this directory owns product orchestration around it.

## Turn Handling

- A turn may reply, intentionally remain silent, pause for authorization,
  cooperatively yield, or fail.
- Silence is explicit; absence of model text is not automatically a successful
  silent outcome.
- Tool calls and intermediate text are not destination replies.
- The runtime posts only finalized assistant output and records it only after
  delivery succeeds.
- Resumed runs continue the same durable turn and must not repeat already
  committed side effects.

## Durable Continuation

- Conversation events append at safe boundaries with monotonic sequence numbers.
- Restoration reduces the current context epoch into Pi messages and derived
  runtime state.
- A timeout or soft execution limit yields only at a boundary where tool results
  and state updates are durable.
- Auth pauses persist the pending authorization state and end the live run;
  callbacks append new work and start a later run.
- Completion and delivery markers make retries idempotent.
- Canonical turn lifecycle uses stable correlation IDs: input is durable before
  `turn_started`, and completion/failure is appended only at the owning
  delivery-and-persistence boundary. Competing terminal writes share one
  idempotency key, so the first committed outcome wins.
- Intentional silence is a `turn_completed` `no_reply` outcome and does not
  create a synthetic visible assistant message.
- Ordinary finalized Slack thread replies use a durable intent before the
  first post, opaque per-part metadata, one-attempt writes, and receipt
  reconciliation. Creating the intent atomically commits model continuity to
  conversation events and stores only event cursors in the outbox. A redelivered
  inbox record advances that outbox without rerunning Pi; accepted delivery
  commits visible facts and the turn terminal before the inbox is acknowledged,
  while definitive rejection before any accepted part rolls live Pi context
  back to the pre-intent cursor. A partial multipart rejection records only the
  accepted Slack prefix as visible, retains full model/tool continuity, and
  terminalizes as `delivery_failed`.
- Final replies from OAuth and continuation resumes use the same outbox.
  Heartbeat advances due intents without rerunning Pi, and repairs session and
  derived thread state before terminalization can delete the intent.
- Authorization/private notices, canvas recovery, and generic Chat SDK
  fallback notices retain their owning delivery semantics.
- Recovery repairs canonical conversation state and terminal session metadata;
  exact reconstruction of artifact-only Redis scratch after process loss
  remains a separate bounded follow-up rather than widening the durable reply
  command with arbitrary artifact payloads.

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

- Compaction creates a new context epoch with a bounded replacement summary;
  visible conversation history remains unchanged.
- The replacement must retain unresolved work, durable facts, active artifacts,
  tool outcomes needed for continuation, and relevant actor/destination context.
- Model handoff is a permanent in-place transition recorded at a safe boundary.
  It does not fork the conversation or replay completed side effects.
- Restoration uses the model and context epoch recorded by durable history, not
  process-local assumptions.

Representative integration coverage lives under
`packages/junior/tests/integration/runtime/`.
