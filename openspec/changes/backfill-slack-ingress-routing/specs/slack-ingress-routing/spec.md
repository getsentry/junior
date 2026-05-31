## ADDED Requirements

### Requirement: Slack thread identity normalization

Junior SHALL normalize Slack message thread identity from Slack event fields before queueing or runtime dispatch.

#### Scenario: Slack event has channel and thread timestamp

- **WHEN** a Slack message event includes raw `channel` and `thread_ts`
- **THEN** Junior SHALL use `slack:<channel>:<thread_ts>` as the canonical thread id

#### Scenario: Slack event has channel and no thread timestamp

- **WHEN** a Slack message event includes raw `channel` and `ts` but no `thread_ts`
- **THEN** Junior SHALL use `slack:<channel>:<ts>` as the canonical thread id

#### Scenario: Adapter thread id conflicts with raw Slack fields

- **WHEN** an adapter-provided Slack thread id conflicts with raw Slack `channel` or timestamp fields
- **THEN** Junior SHALL prefer the raw Slack event fields for the canonical thread id

#### Scenario: Raw Slack fields are unavailable

- **WHEN** raw Slack fields are missing or the thread id is not a Slack thread id
- **THEN** Junior SHALL preserve the original thread id rather than guessing

### Requirement: Message-kind classification and runtime dispatch

Junior SHALL route inbound user messages to the correct runtime entrypoint without owning reply/no-reply policy in ingress.

#### Scenario: Direct message is received

- **WHEN** a Slack direct message is received
- **THEN** Junior SHALL route it to the active mention/direct-request runtime path so it is reply-eligible without passive subscribed-thread classification

#### Scenario: Subscribed non-DM message is received

- **WHEN** a non-DM message arrives in a subscribed thread
- **THEN** Junior SHALL route it to the subscribed-message runtime path for passive reply-policy handling

#### Scenario: Explicit mention in unsubscribed thread is received

- **WHEN** a message explicitly mentions Junior in an unsubscribed thread
- **THEN** Junior SHALL route it to the active mention runtime path

#### Scenario: Unsubscribed non-mention message is received

- **WHEN** a non-DM message does not mention Junior and the thread is not subscribed
- **THEN** Junior SHALL not dispatch a normal assistant turn

### Requirement: Queue handoff and skipped message preservation

Junior SHALL preserve Chat SDK queue/skipped-message context when dispatching Slack messages into the runtime.

#### Scenario: Message is queued and deserialized

- **WHEN** a queued Slack message is deserialized before runtime dispatch
- **THEN** Junior SHALL rehydrate private Slack file fetchers for attachments that still have private URLs

#### Scenario: Skipped messages are provided by the queue

- **WHEN** Chat SDK provides skipped messages in `MessageContext`
- **THEN** Junior SHALL pass those skipped messages to the runtime and rehydrate their attachment fetchers before use

#### Scenario: Dispatcher receives a mention kind

- **WHEN** queued dispatch receives `kind="new_mention"`
- **THEN** Junior SHALL call the runtime mention handler

#### Scenario: Dispatcher receives a subscribed kind

- **WHEN** queued dispatch receives `kind="subscribed_message"`
- **THEN** Junior SHALL call the runtime subscribed-message handler

### Requirement: Webhook background processing

Junior SHALL process Slack webhook work through the platform background-task hook so HTTP acknowledgement is not coupled to long-running turn execution.

#### Scenario: Background task hook is available

- **WHEN** Junior receives message, reaction, action, slash-command, assistant lifecycle, or app-home webhook work
- **THEN** Junior SHALL enqueue the work through `waitUntil` or equivalent background processing

#### Scenario: Background task hook is missing

- **WHEN** webhook processing requires background execution and no background-task hook is available
- **THEN** Junior SHALL fail loudly rather than silently running long work outside the expected webhook lifecycle

#### Scenario: Background task fails

- **WHEN** a non-message webhook background task fails
- **THEN** Junior SHALL log the failure without retrying unrelated handlers or converting the failure into an agent turn

### Requirement: Assistant lifecycle routing

Junior SHALL route Slack assistant lifecycle events to lifecycle runtime handlers, not normal assistant answer generation.

#### Scenario: Assistant thread starts

- **WHEN** Slack sends `assistant_thread_started`
- **THEN** Junior SHALL call assistant-thread-started handlers using the live assistant thread context and SHALL NOT run a normal assistant answer for that event

#### Scenario: Assistant context changes

- **WHEN** Slack sends `assistant_thread_context_changed`
- **THEN** Junior SHALL call assistant-context-changed handlers using the live assistant thread context and SHALL NOT reset conversation-specific context as if a new user turn started

### Requirement: Edited-message mention extraction

Junior SHALL synthesize an active mention message from Slack edit events only when an edit newly mentions Junior.

#### Scenario: Edit newly adds Junior mention

- **WHEN** a Slack `message_changed` event's edited message text contains Junior's Slack mention and the previous message text did not
- **THEN** Junior SHALL synthesize a mention message using the edited message timestamp, thread timestamp, channel, user, text, attachments, and raw Slack identity fields

#### Scenario: Edit already mentioned Junior

- **WHEN** both the previous and edited text mention Junior
- **THEN** Junior SHALL NOT synthesize a duplicate mention turn for that edit

#### Scenario: Edit does not mention Junior

- **WHEN** the edited text does not mention Junior
- **THEN** Junior SHALL ignore the edit for mention-turn purposes

### Requirement: External and bot-authored ingress filtering

Junior SHALL avoid starting assistant turns from Slack users or messages that are outside the supported requester boundary.

#### Scenario: External Slack Connect user message is received

- **WHEN** ingress identifies a message as authored by an external Slack Connect user outside Junior's supported workspace boundary
- **THEN** Junior SHALL ignore the message before queue/runtime dispatch

#### Scenario: Junior-authored or bot-authored message is observed

- **WHEN** runtime receives a message authored by Junior itself or an unsupported bot message
- **THEN** Junior SHALL avoid starting a normal assistant turn

### Requirement: Slack ingress verification taxonomy

Slack ingress verification SHALL separate pure payload normalization, queue/dispatcher mechanics, and runtime behavior.

#### Scenario: Payload normalization is verified

- **WHEN** verifying thread-id repair, message-kind classification, edited-message extraction, external-user filtering, or attachment fetcher rehydration
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Runtime handoff is verified

- **WHEN** verifying direct-message routing, skipped-message propagation, assistant lifecycle behavior, or subscribed/mention runtime entrypoints
- **THEN** the primary coverage SHALL be integration tests

#### Scenario: Reply/no-reply judgment is verified

- **WHEN** verifying whether Junior should answer a subscribed thread
- **THEN** verification SHALL belong to `agent-turn-handling`, not this ingress capability
