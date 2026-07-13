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

- Agent steps are appended at safe boundaries with monotonic sequence numbers.
- Restoration reduces the current context epoch into Pi messages and derived
  runtime state.
- A timeout or soft execution limit yields only at a boundary where tool results
  and state updates are durable.
- Auth pauses persist the pending authorization state and end the live run;
  callbacks append new work and start a later run.
- Completion and delivery markers make retries idempotent.

## Conversation Runtime

- Every production agent entry point runs through the shared conversation
  runtime before entering the common `AgentRunner` and Pi kernel.
- A canonical `conversationId` loads or atomically materializes the immutable
  execution profile used by every slice of that conversation.
- The execution profile is conversation-owned configuration for model profile,
  reasoning, additional instructions, and tool restrictions.
- Profile tool policy can narrow host authority but cannot grant tools,
  credentials, destinations, or other capabilities.
- Turn-session metadata keeps the starting model separate from the latest
  active model so reporting does not rewrite the start after a handoff.
- Durable context epochs remain authoritative after model handoff; loading the
  execution profile must not roll the conversation back to its initial model.

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
