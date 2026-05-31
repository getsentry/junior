## ADDED Requirements

### Requirement: Slack entry surfaces

Junior SHALL support Slack delivery for direct messages, explicit channel or thread mentions, subscribed-thread follow-ups that route to a reply, and Slack assistant-thread lifecycle events.

#### Scenario: Direct message starts a turn

- **WHEN** Slack delivers a direct user message to Junior
- **THEN** Junior SHALL treat the message as reply-eligible explicit user input instead of passive subscribed-thread traffic

#### Scenario: Mention starts a turn

- **WHEN** Slack delivers a channel or thread message that explicitly mentions Junior
- **THEN** Junior SHALL run the explicit-mention turn path and bypass passive no-reply classification

#### Scenario: Subscribed follow-up is skipped

- **WHEN** Slack delivers a subscribed-thread message and the subscribed-thread policy decides Junior should not reply
- **THEN** Junior SHALL persist the skip decision without posting a visible reply or adding the automatic processing reaction

#### Scenario: Assistant lifecycle event arrives

- **WHEN** Slack delivers `assistant_thread_started` or `assistant_thread_context_changed`
- **THEN** Junior SHALL initialize or refresh assistant-thread metadata without treating the lifecycle event itself as a normal user turn

### Requirement: Slack thread context sourcing

Junior SHALL build ongoing Slack turn context from persisted normalized conversation state after initial seeding, while preserving attachment and assistant-thread context needed by later turns.

#### Scenario: Local conversation state is empty

- **WHEN** Junior prepares the first known turn for a Slack thread and local conversation state has no usable messages
- **THEN** Junior MAY seed the conversation from available Slack thread history or provided thread messages

#### Scenario: Local conversation state exists

- **WHEN** Junior prepares a later turn for a Slack thread with persisted conversation state
- **THEN** Junior SHALL build prompt context from persisted normalized conversation state rather than depending on an ad hoc Slack thread-history fetch

#### Scenario: Live assistant-thread identifiers are available

- **WHEN** Junior updates assistant-thread title or status
- **THEN** Junior SHALL use the live Slack `channel_id` and `thread_ts` for the current event and SHALL normalize adapter-scoped channel identifiers before calling Slack assistant-thread APIs

#### Scenario: DM message lacks an assistant thread timestamp

- **WHEN** a Slack DM message event lacks the assistant thread timestamp needed for assistant-thread APIs
- **THEN** Junior SHALL skip assistant-thread status/title updates instead of synthesizing a thread root from unrelated persisted state

### Requirement: Assistant-thread lifecycle delivery

Junior SHALL keep Slack assistant-thread lifecycle behavior useful and non-destructive.

#### Scenario: Assistant thread starts

- **WHEN** Slack reports a newly started assistant thread
- **THEN** Junior SHALL set an initial title, set suggested prompts, normalize Slack conversation IDs, and persist source-channel context when Slack provides it

#### Scenario: Assistant thread context changes

- **WHEN** Slack reports an assistant-thread context change
- **THEN** Junior SHALL refresh suggested prompts and source-channel context without resetting an existing conversation-specific title to a generic default

#### Scenario: Conversation title is generated

- **WHEN** Junior updates an assistant-thread title to a conversation-specific value
- **THEN** Junior SHALL derive the title from the earliest known human message for that thread and SHALL NOT delay final reply delivery on title generation

### Requirement: In-flight Slack progress

Junior SHALL expose in-flight progress through Slack assistant status, and SHALL keep that progress separate from finalized reply artifacts.

#### Scenario: Turn starts

- **WHEN** Junior begins a non-trivial Slack turn with enough live assistant-thread identifiers
- **THEN** Junior SHALL start a non-empty assistant status early and SHALL NOT wait for the Slack status write before continuing model or tool execution

#### Scenario: Status is updated

- **WHEN** Junior has an explicit progress update
- **THEN** Junior SHALL place the user-visible progress copy in Slack's loading surface and SHALL keep the raw Slack status stable and generic while the turn is active

#### Scenario: Status write fails

- **WHEN** Slack rejects or fails an assistant-status update
- **THEN** Junior SHALL log or observe the failure and continue the turn because status delivery is best effort

#### Scenario: Turn stops

- **WHEN** a Slack turn reaches a final reply, pause, skip, or failure boundary
- **THEN** Junior SHALL clear assistant status best effort

#### Scenario: Compaction runs before execution

- **WHEN** Junior performs automatic pre-turn context compaction
- **THEN** Junior SHALL show explicit compaction progress before the compaction model call and return to normal turn status before assistant execution begins

### Requirement: Automatic processing reaction

Junior SHALL use an automatic Slack processing reaction to acknowledge messages it has committed to handle, without treating that reaction as model-authored progress.

#### Scenario: Explicit mention starts processing

- **WHEN** Junior accepts an explicit mention or direct message for processing
- **THEN** Junior SHALL add the automatic `eyes` reaction before turn preparation or assistant execution and remove it when the handler completes

#### Scenario: Subscribed message becomes reply-eligible

- **WHEN** a subscribed-thread message is approved for a reply
- **THEN** Junior SHALL add the automatic `eyes` reaction after the reply decision and before assistant execution

#### Scenario: Reaction write fails

- **WHEN** Slack fails the automatic reaction add or remove call
- **THEN** Junior SHALL observe the failure without changing reply routing or turn success by itself

#### Scenario: Assistant explicitly adds eyes

- **WHEN** the assistant uses the Slack reaction tool to add `eyes` to the same inbound message
- **THEN** Junior SHALL leave that reaction in place when automatic processing cleanup runs

### Requirement: Finalized Slack replies

Junior SHALL use finalized Slack thread posts as the primary visible reply artifact for Slack turns.

#### Scenario: Model emits provisional deltas

- **WHEN** the assistant emits text deltas before the final reply is resolved
- **THEN** Junior SHALL NOT publish those deltas as visible Slack reply text

#### Scenario: Final reply is ready

- **WHEN** Junior has the finalized assistant reply and delivery plan
- **THEN** Junior SHALL render reply text through the shared Slack output translator and deliver the planned Slack thread posts

#### Scenario: Final delivery fails

- **WHEN** Slack rejects the final visible thread reply
- **THEN** Junior SHALL treat the turn as failed and SHALL NOT persist assistant conversation state as if the user saw the reply

#### Scenario: Channel-side effect satisfies explicit intent

- **WHEN** the user explicitly requested an in-channel side effect and that side effect already satisfied the request
- **THEN** Junior MAY suppress redundant thread text according to the reply-delivery plan

#### Scenario: Final footer metadata is included

- **WHEN** Junior includes finalized reply diagnostics
- **THEN** Junior SHALL attach them as structured footer metadata on the final text chunk only, not as in-flight progress

### Requirement: Slack continuation formatting

Junior SHALL split finalized Slack replies that exceed the repository inline budget while preserving readable Slack markdown.

#### Scenario: Reply exceeds inline budget

- **WHEN** a finalized reply exceeds the Slack inline reply budget
- **THEN** Junior SHALL split it into multiple thread messages

#### Scenario: Reply needs more than two chunks

- **WHEN** a finalized reply needs more than two Slack messages
- **THEN** Junior SHALL append `[Continued below]` to each non-final overflow chunk

#### Scenario: Reply needs exactly two chunks

- **WHEN** a finalized reply needs exactly two Slack messages
- **THEN** Junior SHALL omit `[Continued below]` from the first chunk because the thread order is sufficient

#### Scenario: Provider failed after partial text

- **WHEN** the final visible reply ended because the provider failed mid-turn
- **THEN** Junior SHALL append `[Response interrupted before completion]` to the final visible chunk

#### Scenario: Chunk boundary is inside a fenced code block

- **WHEN** a continuation boundary lands inside an open fenced code block
- **THEN** Junior SHALL close the fence before the continuation marker and reopen the fence at the start of the next chunk

### Requirement: Slack file delivery

Junior SHALL deliver assistant-produced files through the same finalized Slack reply-delivery plan as text.

#### Scenario: Reply has text and files

- **WHEN** a finalized thread reply includes files and the delivery plan allows inline files
- **THEN** Junior SHALL attach the files to the first visible thread reply post when possible

#### Scenario: Reply has files but no text

- **WHEN** a finalized reply contains files and no visible text
- **THEN** Junior SHALL still create a visible Slack thread artifact carrying the files

#### Scenario: Thread text is intentionally suppressed

- **WHEN** thread text is suppressed but files remain part of the reply contract
- **THEN** Junior SHALL still deliver the files through the reply planner unless the delivery plan explicitly excludes them

#### Scenario: Resume flow has files

- **WHEN** a resumed Slack turn returns files
- **THEN** Junior SHALL use the same finalized reply planning semantics for file delivery as the live runtime path

### Requirement: Slack image ingress preservation

Junior SHALL preserve Slack image attachments as recoverable turn context across ingress, persistence, and skipped-message paths.

#### Scenario: Inbound Slack message has file attachments

- **WHEN** Slack delivers image or file attachments on a user message, including a `message_changed` event
- **THEN** Junior SHALL preserve those attachments through ingress normalization

#### Scenario: Private file fetcher crosses a boundary

- **WHEN** a Slack attachment is deserialized or side-channeled through a webhook handler
- **THEN** Junior SHALL rehydrate any private-file fetcher before runtime processing needs the file bytes

#### Scenario: Passive image message is skipped

- **WHEN** a subscribed-thread message with potential image attachments is skipped before image hydration
- **THEN** Junior SHALL NOT permanently mark the image context as hydrated

#### Scenario: Vision is unavailable

- **WHEN** Slack delivered an image attachment but the current runtime cannot analyze images
- **THEN** Junior SHALL tell the assistant that an image was received but analysis is unavailable, and SHALL NOT allow a reply to claim no image was attached

### Requirement: Slack resume delivery

Junior SHALL make paused or resumed Slack turns obey the same final visible delivery contract as live turns.

#### Scenario: Timeout continuation is scheduled

- **WHEN** a live turn is paused for automatic timeout continuation
- **THEN** Junior SHALL post a durable thread acknowledgement that the turn is continuing in the background

#### Scenario: User repeats an awaiting continuation

- **WHEN** a follow-up or duplicate delivery reaches a thread with the same awaiting continuation
- **THEN** Junior SHALL acknowledge or reschedule the existing continuation instead of starting a second visible turn for the same work

#### Scenario: Auth pause occurs

- **WHEN** a Slack turn pauses for OAuth or MCP authorization
- **THEN** Junior SHALL privately deliver the secret-bearing authorization link, post only a brief visible acknowledgement in the thread, clear the active turn, and persist pending-auth state

#### Scenario: Auth resumes stale work

- **WHEN** authorization completes after a newer thread message has replaced the blocked request
- **THEN** Junior SHALL store the credentials without posting a stale resumed answer

#### Scenario: Resume final reply is delivered

- **WHEN** a paused turn resumes and produces a final answer
- **THEN** Junior SHALL deliver the answer through the shared Slack reply planner before marking resume success

#### Scenario: Resume final delivery fails

- **WHEN** Slack rejects the final resumed visible reply
- **THEN** Junior SHALL treat the resumed turn as failed and avoid committing state that implies delivery succeeded

### Requirement: Slack delivery verification taxonomy

Slack delivery verification SHALL keep behavior coverage separate from low-level Slack transport contracts and model-dependent reply quality.

#### Scenario: User-visible Slack workflow is verified

- **WHEN** a test verifies DM, mention, subscribed-thread, assistant lifecycle, resume, file, image, continuation, or final-reply behavior
- **THEN** the primary layer SHALL be an integration test with scenario-readable names

#### Scenario: Raw Slack request shape is verified

- **WHEN** a test verifies Web API parameters, headers, ID normalization, retry/error mapping, block shape, or file upload request shape
- **THEN** the primary layer SHALL be a dedicated Slack transport-contract integration or small deterministic unit test

#### Scenario: Natural-language reply behavior is verified

- **WHEN** the contract depends on prompt-following, reply quality, routing judgment, or tool-choice interpretation
- **THEN** the primary layer SHALL be an eval rather than a Slack transport test
