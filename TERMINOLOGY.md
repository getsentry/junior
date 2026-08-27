# Terminology

Canonical words used across Junior's code and documentation.

## Terms

- **Workspace**: a named recipe that selects repositories and setup
  instructions for a Sandbox snapshot.
- **Repository**: a source-code repository known to Junior, regardless of its
  hosting service.
- **Code change**: a proposed change to a repository. GitHub calls it a pull
  request. GitLab calls it a merge request.
- **Commit**: one recorded repository revision. Its hosting service owns the
  commit identifier.
- **Sandbox**: an isolated execution environment for a run or snapshot build.
- **Conversation**: the durable container for visible history and execution
  state, identified by a globally unique `conversationId`.
- **Source**: where an inbound event came from, such as Slack, local CLI, web
  (dashboard), scheduler, or plugin dispatch.
- **Destination**: where Junior sends output or side effects.
- **Location**: optional provider context for a conversation or input,
  identified by Junior and provider ids. A run may keep this context when its
  Source or Actor is not from that provider. Location does not grant delivery.
  Conversation visibility is separate.
- **publishExternally**: whether one turn also publishes assistant output to the
  conversation destination. The conversation log always stores the turn. Slack
  surfaces treat missing as publish; non-Slack work treats missing as
  conversation-only. Explicit false always means conversation-only.
- **User**: one person-level record. A user may have several linked identities.
- **Identity**: one provider account, such as a Slack account in one workspace,
  optionally linked to a user.
- **Actor**: the runtime participant for one source invocation. Actor ids are
  provider-scoped and are not canonical user ids. An Actor may keep provider
  fields that the agent or tools need. Those fields do not select the runtime.
- **Resource event**: one normalized change identified by namespace, identifier,
  event type, and an idempotency key. Plugins and core can publish them.
  Delivery wakes the conversation; destination stays on that conversation.
- **Resource subscription**: a temporary conversation association that delivers
  matching resource events back into that conversation.
- **Event task**: a durable instruction that dispatches when a matching
  resource event occurs.
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
- **Agent history item**: one replayable model input or output, stored as a
  `user_message`, `assistant_message`, or `tool_result` event. Tool calls remain
  ordered content inside the assistant message that requested them.
- **History replacement**: an explicit compaction or handoff that supplies the
  agent history used by later turns. It is stored as the corresponding event,
  not as a generic context-start marker.
- **History version**: an internal sequence partition used to load agent
  history after a replacement. It is not a product event or lifecycle state.
- **Turn route**: the model profile and reasoning level selected for a turn
  before model execution begins.
- **Model profile**: a stable host-owned model name, such as `standard` or
  `handoff`, recorded on a turn route or history replacement.
- **Message**: exact normalized source or destination chat content stored for
  transcript display, privacy, delivery handling, and search.
- **Message update**: later delivery or hydration state for an existing
  message, stored as a `message_updated` event without creating another message.
- **Transcript**: a reporting view rendered from stored messages and agent
  history items. It is not the stored data itself.
- **Turn checkpoint**: the Redis resume cursor for one turn (status + boundary into SQL history).
- **Conversation execution**: mutable operational state for a conversation,
  such as mailbox state, worker lease, checkpoints, and activity status.
- **Unfinished work**: plugin-owned work associated with a conversation that
  is not complete.
- **Assigned work**: plugin-owned work associated with a conversation, whether
  finished or unfinished.
- **Agent binding**: a named reference, scoped to one parent agent
  conversation, that reuses one child conversation and its history.
- **Agent invocation**: one retry-safe delegated task sent from a parent agent
  conversation to a child conversation, including its durable terminal result.
- **Reasoning level**: the configured or selected amount of model reasoning for
  a turn: `none`, `low`, `medium`, `high`, or `xhigh`.
- **Reply**: a destination-visible message owned by delivery or reply-policy
  code, not agent execution.

## Naming Guidance

- Use `provider` on provider-owned references such as Identity and Location; it
  names the namespace that owns their provider ids.
- Keep Source, Actor, Location, Destination, and `publishExternally`
  independent. Do not infer one from another. Provider data may supply agent
  context without selecting another runtime or granting delivery.
- For new Source unions, use one discriminant for what produced the work. Keep
  provider-native identifiers inside that provider's Source branch rather than
  adding a second generic provider or thread field.
- Use `turn`, `run`, and `slice` only with the meanings above.
- Use `agent invocation` for delegated child work; do not shorten it to
  `invocation` where it could be confused with a model or serverless
  invocation.
- Use `message` for platform chat content. Use `user_message`,
  `assistant_message`, and `tool_result` for replayable agent history.
- Use `agent history item` when referring to those three native event types as
  a group; do not use `model_item` or `model_message`.
- Use `turnId` for new identifiers representing a turn.
- Use `reply` only for destination-visible messages; execution code should use
  `turn`, `run`, `result`, `outcome`, or `delivery` as appropriate.
- Use `transcript` only for reporting views, not storage or runtime interfaces.
- Use `reasoning` in Junior-owned names. Use `thinkingLevel` only at Pi SDK
  boundaries where it is the upstream API name.
- Preserve historical `run`, `reply`, and `sessionId` names unless the owning
  contract is intentionally migrated.
