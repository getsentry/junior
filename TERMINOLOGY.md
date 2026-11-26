# Terminology

Canonical words for Junior code and docs. One concept, one word.

## Terms

- **Workspace**: a named recipe of repos and setup for a Sandbox snapshot.
- **Repository**: a source repository on any hosting service.
- **Code change**: a proposed repo change (pull request, merge request).
- **Commit**: one repository revision. The host owns its id.
- **Sandbox**: an isolated environment for a Run or snapshot build.
- **Preview**: a public URL for a server that runs in a Sandbox. It stops
  working when the Sandbox stops.
- **Deployment**: a revision sent to a target environment.
- **Conversation**: the durable container for visible history and execution
  state, keyed by a unique `conversationId`. Parent is optional and separate
  from Location. Its `kind` is `thread`, `automation`, `lead`, or `task`,
  and never changes. `automation` is a top-level Conversation for an
  Automation run. A `thread` may have a parent.
  A Conversation is the default. Slack is a Destination attached to it. Do not
  say "web Conversation".
- **Visibility**: `public` or `private`, stored on each Conversation. Anyone
  can read a public Conversation. Only its Participants can read a private
  one. Every Conversation in a tree has its root's visibility.
- **Lead**: a Space's Conversation that finds, starts, and steers the
  Space's other Conversations. Each Space has one, and only the Lead stores
  its Space. The Space's other Conversations are its child agents, and the
  Lead is the root of their tree. It does no work itself.
- **Top-level Conversation**: a Conversation with no parent, or a child of a
  Lead. Top-level lists show these.
- **Space**: a named, shared home for a body of related work. A
  **Member** of a Space is a Participant of its Lead: a User who joined,
  was added, or posted in the Space.
- **Thread**: a Conversation of kind `thread`, which people can message. It
  is a root, or a child agent that `startAgent` starts as a `thread`. Say
  "Slack thread" for the Location. A bare "Thread" is the Conversation.
- **Task**: a child Conversation that only its parent messages. People can
  view it. Existing code names with `task` (`task-execution`, the Ticket
  `task` type, the `startAgent` `task` field) keep their meaning.
- **Team**: an agent and its child agents. A Lead's child agents are the
  Conversations in its Space. It sets who manages an agent, not access.
- **Agent update**: the one Event (`agent.update`) that every agent sends
  when a Turn ends, or when it waits, is blocked, fails, or stops.
- **Subagent**: the mechanism behind Threads and Tasks (`startAgent`, Agent
  bindings, Parent messages). Not a UI word.
- **Conversation metadata**: the stored facts about a Conversation: its
  title and summary. A core task updates the summary after each Turn. A
  public summary outlives the transcript.
  Do not say "Brief"; it is the retired name.
- **Catch-up**: a short summary of the rows after a reader's read position,
  and what waits on them. Made on request and not stored.
- **Source**: the input that caused work (Slack message, CLI, dashboard,
  Event, Automation, plugin dispatch, Parent message). Each Inbound message
  has one; a Turn stores the one that started it.
- **Destination**: an explicit target for output or a side effect. Not a
  synonym for Location; a new Conversation stores it as its Location.
- **Location**: the one outside place (a Slack channel or a Slack thread) a
  Conversation is delivered to. The Run carries it. It grants no delivery or
  visibility.
- **Delivery**: sends Run output to the Location. Without it, only completed
  assistant Messages are stored. Only a Conversation that has its own
  Location delivers to it, such as a root or a Slack Conversation that moved
  into a Space. A child stores its output and returns it to its parent.
- **Conversation execution**: mutable operational state (mailbox, worker
  lease, checkpoints, activity status).
- **Conversation status**: what one Conversation's own work needs, shared
  by everyone and derived from runtime state only. `needs_input`: it waits on
  a person: an open action Inbox item it added, a sign-in, or its starter
  while no Turn is queued or running (a failed latest Turn or an answer the
  starter has not read). `working`: a Turn is queued or running. `done`:
  anything else, also a stop. The first that applies wins, in that order.
  `completed` is a Turn or run outcome, never a Conversation status.
- **Starter**: the User of a root's actor, the person whose message started
  it or the creator of an Automation run. Its child Conversations share it.
- **Archived**: a flag on a Conversation, shared by everyone. It is not a
  status, and an archived Conversation keeps its status.
- **Viewer state**: what a Conversation and its child Conversations need from
  one viewer. Code and the API call it `treeState`. `needs_you`: the tree's
  `needs_input` includes the viewer or Everyone. `working`: a Turn is queued
  or running in the tree. `done`: anything else. The first that applies wins.
  A separate `watching` flag says that a Conversation in the tree has an
  active Watch or a pending Timer. It is not a status.
- **Conversation note**: a core fact on a Conversation, shown to the next Turn
  as runtime context. It starts no Turn, is not a Message, and has no authority.
- **User**: one person-level record with zero or more linked Identities.
- **Identity**: one provider account (for example, a Slack account in one
  workspace), optionally linked to a User.
- **Actor**: the runtime participant for one source invocation. Ids are
  provider-scoped. Junior is the web provider, so a web Actor id is the User
  id. Provider fields do not select the runtime. A Turn stores the starting
  Actor; steering inputs keep their own.
- **Participant**: a User who is the Actor of a Turn in a root Conversation or
  its children, or who was invited to it. A Participant is active until they
  Leave; an inactive Participant keeps access but leaves the active feed. Access, feeds, and defaults that need people use Participants. A
  Conversation has no owner. The root Actor (`actor_identity_id`, the Actor
  of the first Turn) is a Participant like any other, and is kept only for
  attribution such as spend.
- **Invite**: a person subscribes someone to a Conversation's feed, with
  the people picker of its Participants. In a public Conversation, a
  dashboard or Slack Message that mentions them also does it, and access
  stays the same, because anyone can already read it and join by posting.
  In a private Conversation, only a Participant may Invite, and it gives
  access. A private Space and a Slack-backed private Conversation refuse it.
- **Leave**: a Participant takes a Conversation out of their feed, and Join
  puts it back. In a private Conversation with its own Participant list,
  Leave also ends access until someone Invites them again. Nobody removes
  another person.
- **Work owner**: who a Turn's work is credited to, for attribution only: the
  person Actor of the Turn, else the root Actor if it is a person, else the
  system record that started the root, such as an Automation run.
- **Admin**: a User with the Junior-wide admin role, set only by
  `junior admin`. Plugins use it for restricted setup. No plugin admin lists.
- **Service account**: a provider account Junior uses for one plugin, allowed
  by `accounts.service-account` and connected by an Admin (dashboard or
  `junior service-account connect`). It serves Actors with no own connection,
  for the MCP tools or `egress.fetch` operations that it lists;
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
- **Quiet Event**: a Watch Event that the code that made the Watch marked
  quiet. Core saves it as a Conversation note and starts no Turn.
- **Event author**: the account that wrote the content of an Event, such as
  a commenter. A plugin reports it as `EventAuthor` (facts only). An Event
  with no author is a system Event. The author never becomes the Turn Actor.
- **Author trust**: core's decision for one Event author, `AuthorTrust`:
  `system`, `trusted`, or `untrusted` with a reason. Core makes it once at
  ingest. `chat/identities/trust.ts` owns it and every other trust check
  (Slack ingress, Identity dispatch, allowed emails).
- **Trusted author**: an Event author with `trusted` Author trust. Like a
  Slack author, a linked person writes the Event's Message. Any other author
  is an Untrusted author: the Event runs as system context, and the task
  input says the account is not verified. Text from the person's own linked
  account counts as their message. Any other author's text is context for
  the Watch or Automation task, never an instruction.
- **Stopped Conversation**: a Conversation with `stopped_at` set. Its Watch
  Events are saved as skipped Messages and start no Turn. A stop marks the
  Conversation and its child agents, and drops the Parent messages that wait
  for them. A run that sees its stop late also stops the child agents that it
  spawned or messaged after the stop. A person's input sent after the stop,
  or new work from a child's parent, ends the stop. A stopped parent gives no
  new work: `messageAgent` to a child leaves a Conversation note, and
  `startAgent` fails. A person's stop keeps the
  Watches; an agent's `stopAgent` also cancels them. Reports show it as
  `stopped` while no work runs.
- **Event reach**: `"all"`, `{ anyOf }` (needs a named filter), or `"resource"`
  (needs an identifier) per event type. Limits noise, not access.
- **Inbound message**: one normalized source event given to the agent.
  **Agent input**: the content, context, and metadata chosen for a Turn.
- **Steering message**: a message that joins the active Turn at the next safe
  boundary. **Follow-up message**: one that waits for the next Turn.
- **Mailbox delivery**: `interrupt` (next safe boundary) or `defer` (in order).
- **Turn**: one request-to-final-response cycle. Not one model call.
- **Answer**: the tool call that ends a gated Turn: `reply`, `noReply`, or
  `reportBlocked`. Only an Automation run's Turn that a person did not open
  is gated. Its final response is not delivered.
- **Run**: one bounded attempt to advance a Turn. A later Run may resume the
  same Turn after a pause, yield, or recoverable failure.
- **Execution slice**: one serverless invocation segment of a Run. **Turn
  checkpoint**: the Redis resume cursor for one Turn.
- **Reasoning level**: `none`, `low`, `medium`, `high`, or `xhigh`.
- **Loader**: a named source of data for a core prompt, such as a database
  row or a service. Loaders do all of the I/O of a prompt. Core runs each
  needed Loader once for each step.
- **Fragment**: a named piece of a core prompt. It formats one Loader's value
  into messages. It does no I/O, and reads no clock or random value.
- **Prompt layout**: the System prompt sections and the message Fragments
  of a core prompt, in order. It has exactly one inputs Fragment, made with
  `inputs()`, which sets where the Turn's unread inputs go. The host checks
  it once at startup with `definePromptLayout`.
- **System prompt section**: a named, static piece of the system prompt in a
  core prompt. The host builds it once at startup. It holds no Conversation
  data.
- **Prompt diagnostics**: how core built one prompt: the size of each System
  prompt section, how each Loader ran, and whether each Fragment was
  included, skipped, or disabled. It holds no content.
- **Agent history item**: a `user_message`, `assistant_message` (holds its
  tool calls), `tool_result`, or `system_message` (a Pi system message after
  the leading one) event. Not `model_item` or `model_message`.
- **History replacement**: a compaction that sets later history.
  **History version**: the internal partition loaded after it.
- **Message**: normalized chat content stored for display, privacy, delivery,
  and search. **Message update**: later state stored as `message_updated`.
- **Reply**: a destination-visible Message owned by delivery or reply-policy
  code. Execution code says turn, run, result, outcome, or delivery.
- **Quiet message**: a Message in older history that Junior stored but did
  not deliver. A `noReply` note is not a Message.
- **Transcript**: a reporting view of Messages and history. Not storage.
- **Quick question**: a hidden, read-only fork that asks about text in one
  Reply. Keep as fork makes it a normal fork.
- **Agent binding**: a parent-scoped name for one child Conversation.
- **Parent message**: a task or message from a parent to a child. It waits
  in the child's mailbox as other input does, and runs as the Actor of the
  parent's Turn, with that Turn's credentials. The child checks its sender
  before it runs it. The child's final text, or a failed, blocked, or
  stopped result, reaches the parent. Do not say "Agent invocation"; it is the
  retired name.
- **Agent message**: `messageAgent` text to a parent, a child, or another
  top-level agent (the agent of a root Conversation). To a child it is the
  child's instruction: a Parent message that starts work or steers a running
  Turn.
  To a parent or a top-level agent it is an Event Inbound message. The
  agent's own text gives no user approval. A person's own words that it
  passes on, linked to where the person wrote them, count as that person's
  lines.
- **Agent type**: a `startAgent` preset for a child agent: when to pick it,
  whether it forks history, and per-task instructions. It does not limit tools.
- **Tool exposure**: who may call a tool: the model, the tool catalog
  (`searchTools` and `executeTool`), or a Code Mode script (a script that
  calls tools with `tools.x(args)`). `ToolExposure` owns the values.
- **Annotation**: saved facts or a link on one Conversation, for an object
  that it created or changed. A read saves none. An update sends no message.
- **Ticket** (`task`), **Calendar event** (`calendar_event`), **Item**: the
  Annotation types for provider work items, meetings, and other objects.
- **Message card**: a Message's reference to an Annotation, shown with the
  latest saved facts. No live provider fetch.
- **Unfinished work** / **Assigned work**: plugin-owned work on a
  Conversation, open / open or done.
- **Inbox item**: work for a person, shown in the **Inbox**. Not an
  Item or a Review item. **Assignee**: a User or Everyone (anyone who can see it). **Owner**:
  what the item belongs to, `{ kind, id }`: the Conversation that added it,
  or an Automation. The owner sets the item's visibility, tenant, and Inbox
  stack. **Automation alert**: an Inbox item that an Automation owns. Core
  adds it for the creator when the Automation needs them, and closes it
  when the Automation recovers.
- **Attention**: what Junior takes from a person with a reply, a question, a
  Slack post or DM, an Inbox item, a review request, a push, or an Inbox
  count. A Watch Event goes to the agent and takes none. Not
  "notification". **Notice**: an Inbox item that names a step for a
  person but asks no question.
- **Dismiss**: close an Inbox item without an answer. The one UI word for
  removing an item, on a row, a card, or many FYIs at once. Not Clear or
  Done. Archive is for a Conversation.
- **Done** (Inbox): the view of done and dismissed Inbox items. Not
  Conversation archive.
- **Snooze**: one User hides one Inbox item in their Inbox until a
  trigger, such as a timer or an Event, wakes or resolves it. A later item
  in the row is not snoozed.
  Not an Automation. **Someday**: a Snooze with no trigger. It lasts until
  the item closes, such as when someone else handles it, or until the User
  wakes it. **Snoozed** (Inbox): the view of the User's snoozed items.
- **To-do**: one entry in the durable list of work that outlives a Turn in
  one Conversation, changed with `todos_updateTodos`. Not a Task or a Plan. Its
  status is open, in progress, done, or dropped. It has one Assignee: the
  Conversation's own agent, one of its child agents, or a User. Each change
  gets a new version. In code: `todo`. A User's open To-do shows in their
  Inbox as a **To do for you** item. **Done** on that row marks the To-do
  done; it has no Dismiss.

## Naming

- `provider` names the namespace of provider ids on Identity and Location.
- Source `kind` says what produced work. Not `platform`.
- Pass Location once on the Run. Never inside Source or Delivery. Never infer
  Delivery from Source, Actor, or Location.
- Use `turnId` for new Turn ids. Keep old `run`, `reply`, and `sessionId`
  names until their contract migrates.
- Use `reasoning`; `thinkingLevel` only at Pi SDK edges.
