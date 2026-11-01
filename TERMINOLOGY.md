# Terminology

Canonical words for Junior code and docs. One concept, one word.

## Terms

- **Workspace**: a named recipe of repos and setup for a Sandbox snapshot.
- **Repository**: a source repository on any hosting service.
- **Code change**: a proposed repo change (pull request, merge request).
- **Commit**: one repository revision. The host owns its id.
- **Sandbox**: an isolated environment for a Run or snapshot build.
- **Deployment**: a revision sent to a target environment.
- **Conversation**: the durable container for visible history and execution
  state, keyed by a unique `conversationId`. Parent is optional and separate
  from Location.
- **Brief**: the versioned record of a Conversation's intent, outcome,
  decisions, facts, and evidence. Public Briefs outlive the transcript.
- **Source**: the input that caused work (Slack message, CLI, dashboard,
  Event, Automation, plugin dispatch, Agent invocation). Each Inbound message
  has one; a Turn stores the one that started it.
- **Destination**: an explicit target for output or a side effect. Not a
  synonym for Location; a new Conversation stores it as its Location.
- **Location**: the one outside place (Slack channel or thread) a Conversation
  is delivered to. The Run carries it. It grants no delivery or visibility.
- **Delivery**: sends Run output to the Location. Without it, only completed
  assistant Messages are stored.
- **Conversation execution**: mutable operational state (mailbox, worker
  lease, checkpoints, activity status).
- **Conversation note**: a core fact on a Conversation, shown to the next Turn
  as runtime context. It starts no Turn, is not a Message, and has no authority.
- **User**: one person-level record with zero or more linked Identities.
- **Identity**: one provider account (for example, a Slack account in one
  workspace), optionally linked to a User.
- **Actor**: the runtime participant for one source invocation. Ids are
  provider-scoped, not User ids. Provider fields do not select the runtime. A
  Turn stores the starting Actor; steering inputs keep their own.
- **Owner**: the Identity that started a root Conversation. Human for Slack,
  web, and fork; the system Identity for Automation runs, plugin dispatch, and
  CLI. Children use the root Owner. Automations have a creator, not an Owner.
- **Admin**: a User with the Junior-wide admin role, set only by
  `junior admin`. Plugins use it for restricted setup. No plugin admin lists.
- **Service account**: a provider account Junior uses for one plugin, allowed
  by `accounts.service-account` and connected by an Admin (dashboard or
  `junior service-account connect`). It serves Actors with no own connection;
  `accounts.user-oauth: false` makes it the only path.
- **Automation**: a saved instruction run later, with a creator, trigger,
  instruction, and ordered outcomes.
- **Schedule**: a time trigger. **Scheduled** / **Event automation**: an
  Automation with a Schedule / Event trigger.
- **Automation version**: one saved definition (title, instruction, trigger,
  Destination, outcomes, credential mode). Not the edit revision.
- **Automation run**: one dispatch of an Automation to its outcome. Not a Run.
- **Event**: one normalized change (namespace, identifier, type, idempotency
  key) from core or a plugin. It can wake a Conversation.
- **Watch**: a temporary link that delivers matching Events to a Conversation.
  Not an Automation.
- **Event reach**: `"all"`, `{ anyOf }` (needs a named filter), or `"resource"`
  (needs an identifier) per event type. Limits noise, not access.
- **Inbound message**: one normalized source event given to the agent.
  **Agent input**: the content, context, and metadata chosen for a Turn.
- **Steering message**: a message that joins the active Turn at the next safe
  boundary. **Follow-up message**: one that waits for the next Turn.
- **Mailbox delivery**: `interrupt` (next safe boundary) or `defer` (in order).
- **Turn**: one request-to-final-response cycle. Not one model call.
- **Run**: one bounded attempt to advance a Turn. A later Run may resume the
  same Turn after a pause, yield, or recoverable failure.
- **Execution slice**: one serverless invocation segment of a Run. **Turn
  checkpoint**: the Redis resume cursor for one Turn.
- **Turn route**: the Model profile and Reasoning level chosen before a Turn.
- **Model profile**: a host model name (`standard`, `handoff`) with an
  optional task-fit description for the router and `handoff`. **Reasoning
  level**: `none`, `low`, `medium`, `high`, or `xhigh`.
- **Agent history item**: a `user_message`, `assistant_message` (holds its
  tool calls), or `tool_result` event. Not `model_item` or `model_message`.
- **History replacement**: a compaction or handoff that sets later history.
  **History version**: the internal partition loaded after it.
- **Message**: normalized chat content stored for display, privacy, delivery,
  and search. **Message update**: later state stored as `message_updated`.
- **Reply**: a destination-visible Message owned by delivery or reply-policy
  code. Execution code says turn, run, result, outcome, or delivery.
- **Transcript**: a reporting view of Messages and history. Not storage.
- **Agent binding**: a parent-scoped name for one child Conversation.
- **Agent invocation**: one retry-safe task from a parent to a child, with
  its terminal result. Never shorten to "invocation".
- **Agent message**: `messageAgent` text to a parent or child. To a child it
  starts an Agent invocation or steers a running one. To a parent it is an
  Event Inbound message. It gives no user approval.
- **Agent type**: a `spawnAgent` preset: when to pick it, whether it forks
  history, and per-task instructions. It does not limit tools.
- **Annotation**: saved facts or a link on one Conversation. An update sends
  no message.
- **Ticket** (`task`), **Calendar event** (`calendar_event`), **Item**: the
  Annotation types for provider work items, meetings, and other objects.
- **Message card**: a Message's reference to an Annotation, shown with the
  latest saved facts. No live provider fetch.
- **Unfinished work** / **Assigned work**: plugin-owned work on a
  Conversation, open / open or done.
- **Review item**: work for a person, shown on the **Review desk**. Not an
  Item. **Assignee**: a User or Everyone (anyone who can see it).

## Naming

- `provider` names the namespace of provider ids on Identity and Location.
- Source `kind` says what produced work. Not `platform`.
- Pass Location once on the Run. Never inside Source or Delivery. Never infer
  Delivery from Source, Actor, or Location.
- Use `turnId` for new Turn ids. Keep old `run`, `reply`, and `sessionId`
  names until their contract migrates.
- Use `reasoning`; `thinkingLevel` only at Pi SDK edges.
