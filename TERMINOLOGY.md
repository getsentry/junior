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
  next safe boundary and joins that turn. Messages arriving together may be
  batched into the same turn.
- **Follow-up message**: a user message that waits for the active turn to finish
  before starting the next turn.
- **Mailbox delivery**: the durable instruction for an inbound message:
  `interrupt` is eligible at the next safe boundary, while `defer` follows
  normal ordering and waits when a turn is already active.
- **Turn**: one request-to-final-response cycle. It may span multiple runs and
  execution slices; one model invocation is not a turn.
- **Run**: one bounded attempt to advance a turn. A later run may resume the
  same turn after a pause, yield, or recoverable failure.
- **Execution slice**: one serverless invocation segment of a run.
- **Agent step**: one replayable entry in agent history, stored as an
  `agent_step` event. Tool calls belong to the assistant step that requested
  them; each tool result is a separate step.
- **History replacement**: an explicit compaction or handoff that supplies the
  agent history used by later turns. It is stored as the corresponding event,
  not as a generic context-start marker.
- **History version**: an internal sequence partition used to load agent
  history after a replacement. It is not a product event or lifecycle state.
- **Model profile**: a stable host-owned model name, such as `standard` or
  `handoff`, recorded on a history replacement.
- **Message**: exact normalized source or destination chat content stored for
  transcript display, privacy, delivery handling, and search.
- **Message update**: later delivery or hydration state for an existing
  message, stored as a `message_updated` event without creating another message.
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
- Use `message` for chat content and `agent_step` for replayable agent history;
  do not use `model_item` or `model_message` as Junior-owned terms.
- Use `turnId` for new identifiers representing a turn.
- Use `reply` only for destination-visible messages; execution code should use
  `turn`, `run`, `result`, `outcome`, or `delivery` as appropriate.
- Use `transcript` only for reporting views, not storage or runtime interfaces.
- Use `reasoning` in Junior-owned names. Use `thinkingLevel` only at Pi SDK
  boundaries where it is the upstream API name.
- Preserve historical `run`, `reply`, and `sessionId` names unless the owning
  contract is intentionally migrated.
