# Terminology

Canonical words used across Junior's code and documentation.

## Terms

- **Conversation**: the durable container for visible history and execution
  state, identified by a globally unique `conversationId`.
- **Source**: where an inbound event came from, such as Slack, local CLI,
  scheduler, or plugin dispatch.
- **Destination**: where Junior sends output or side effects.
- **Inbound message**: one normalized source event made available to the agent.
- **Agent input**: the inbound content, context, and runtime metadata selected
  for a turn.
- **Steering message**: a user message that interrupts the active turn at the
  next safe boundary and starts a new turn. Messages arriving together may be
  batched into that turn.
- **Follow-up message**: a user message that waits for the active turn to finish
  before starting the next turn.
- **Turn**: one request-to-final-response cycle. It may span multiple runs and
  execution slices; one model invocation is not a turn.
- **Run**: one bounded attempt to advance a turn. A later run may resume the
  same turn after a pause, yield, or recoverable failure.
- **Execution slice**: one serverless invocation segment of a run.
- **Agent step**: one durable event in execution history, such as a Pi message
  or host runtime fact. Tool calls belong to the assistant step that requested
  them; each tool result is a separate step.
- **Context epoch**: one generation of model-visible context. Compaction,
  handoff, or rollback opens a new epoch; older epochs remain audit history.
- **Model profile**: a stable host-owned model name, such as `standard` or
  `handoff`, bound to a context epoch.
- **Epoch model id**: the exact provider model recorded when an epoch opens. It
  is audit evidence, not a model pin.
- **Message**: a normalized inbound source event or a stored visible user,
  assistant, or system message.
- **Transcript**: a reporting view rendered from stored messages and agent
  steps. It is not the stored data itself.
- **Session record**: the persisted read model for one resumable turn.
- **Conversation execution**: mutable operational state for a conversation,
  such as mailbox state, worker lease, checkpoints, and activity status.
- **Reasoning level**: the configured or selected amount of model reasoning for
  a turn: `none`, `low`, `medium`, `high`, or `xhigh`.
- **Reply**: a destination-visible message owned by delivery or reply-policy
  code, not agent execution.

## Naming Guidance

- Use `turn`, `run`, `slice`, and `step` only with the meanings above.
- Use `turnId` for new identifiers representing a turn.
- Use `reply` only for destination-visible messages; execution code should use
  `turn`, `run`, `result`, `outcome`, or `delivery` as appropriate.
- Use `transcript` only for reporting views, not storage or runtime interfaces.
- Use `reasoning` in Junior-owned names. Use `thinkingLevel` only at Pi SDK
  boundaries where it is the upstream API name.
- Preserve historical `run`, `reply`, and `sessionId` names unless the owning
  contract is intentionally migrated.
