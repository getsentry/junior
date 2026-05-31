## ADDED Requirements

### Requirement: Visible conversation state authority

Junior SHALL use persisted conversation state as visible Slack-thread memory for routing, prompt background, title generation, image summaries, and turn processing pointers, not as the canonical Pi execution transcript.

#### Scenario: Prompt background is built

- **WHEN** Junior builds visible thread context for routing or prompt background
- **THEN** it SHALL use persisted conversation messages and compaction summaries

#### Scenario: Reusable Pi history is needed

- **WHEN** Junior needs model execution history for replay, resume, or continuation
- **THEN** it SHALL load the agent session projection rather than treating visible conversation messages as the Pi transcript

#### Scenario: Processing pointer exists

- **WHEN** conversation state stores `activeTurnId`, `lastSessionId`, or `pendingAuth`
- **THEN** Junior SHALL treat those fields as routing/read-model pointers to other owned state, not as model-visible lifecycle facts by themselves

### Requirement: State coercion and versioned defaults

Junior SHALL safely coerce unknown persisted thread state into a versioned conversation state with defaults.

#### Scenario: Persisted state is missing or malformed

- **WHEN** thread state lacks a valid conversation envelope
- **THEN** Junior SHALL use a default schema-versioned conversation state

#### Scenario: Persisted message is malformed

- **WHEN** a persisted message lacks required identity, text, or timestamp fields
- **THEN** Junior SHALL omit that message from normalized conversation state

#### Scenario: Persisted pending auth is malformed

- **WHEN** persisted pending auth lacks a supported kind, provider, requester id, session id, or timestamp
- **THEN** Junior SHALL omit pending auth from normalized conversation state

#### Scenario: State patch is persisted

- **WHEN** Junior persists conversation state
- **THEN** it SHALL write the current schema version and refresh message count and update timestamp stats

### Requirement: Visible message upsert and metadata

Junior SHALL normalize inbound Slack messages into visible conversation messages and upsert them by message id.

#### Scenario: New user message arrives

- **WHEN** Junior prepares a turn for an inbound Slack user message
- **THEN** it SHALL persist normalized text, role, author, creation time, Slack timestamp, explicit-mention marker, attachment counts, and image attachment metadata when available

#### Scenario: Queued user messages are included

- **WHEN** queued or skipped user messages are included in a later handled turn
- **THEN** Junior SHALL persist them as visible conversation messages before building conversation context

#### Scenario: Same message id is upserted again

- **WHEN** Junior upserts a message whose id already exists
- **THEN** it SHALL update the existing message and merge metadata rather than appending a duplicate

#### Scenario: Non-text message has no normalized text

- **WHEN** an inbound Slack message cannot produce normalized text
- **THEN** Junior MAY persist a placeholder visible user message so the turn has a stable visible message id

### Requirement: Visible thread backfill

Junior SHALL seed missing visible conversation memory from the Slack thread when a turn first needs context.

#### Scenario: Backfill has already completed

- **WHEN** conversation state records completed backfill
- **THEN** Junior SHALL NOT repeat visible thread backfill for that turn

#### Scenario: Existing messages or compactions are present

- **WHEN** conversation state already has visible messages or compactions
- **THEN** Junior SHALL mark backfill complete using the recent-message source without overwriting existing memory

#### Scenario: Thread history can be fetched

- **WHEN** thread history is available
- **THEN** Junior SHALL seed bounded prior messages up to the backfill limit and exclude messages newer than the current turn

#### Scenario: Thread history fetch fails or is empty

- **WHEN** thread history iteration fails or returns no usable messages
- **THEN** Junior MAY fall back to bounded recent messages from the thread object

### Requirement: Conversation context rendering

Junior SHALL render visible conversation memory as bounded structured context without treating exact rendering prose as a behavior contract.

#### Scenario: Conversation has no messages or compactions

- **WHEN** conversation state is empty
- **THEN** context rendering SHALL return no context block

#### Scenario: Conversation has compactions

- **WHEN** conversation state has visible compaction summaries
- **THEN** context rendering SHALL include those summaries with metadata before the live transcript

#### Scenario: Conversation has messages

- **WHEN** conversation state has visible messages
- **THEN** context rendering SHALL include role, author, timestamp, Slack timestamp when available, message text, skipped/replied markers, explicit mention markers, and image summary references when available

#### Scenario: Current message should be excluded from routing context

- **WHEN** Junior builds routing context for deciding whether to reply
- **THEN** it MAY exclude the current inbound message while keeping prior visible memory

### Requirement: Visible conversation compaction

Junior SHALL keep visible conversation-state context bounded by summarizing older visible messages while retaining recent live messages.

#### Scenario: Visible context exceeds threshold

- **WHEN** estimated visible conversation context exceeds the auxiliary-model compaction threshold and enough live messages remain
- **THEN** Junior SHALL summarize older visible messages into a compaction record and retain a minimum recent live-message tail

#### Scenario: Compaction records exceed limit

- **WHEN** visible compaction records exceed the configured maximum
- **THEN** Junior SHALL merge or prune older compactions so compaction history remains bounded

#### Scenario: Compaction summarization fails

- **WHEN** visible conversation compaction summarization fails
- **THEN** Junior SHALL use a bounded fallback summary rather than failing the user turn

### Requirement: Vision summary state

Junior SHALL persist image-analysis summaries by file id and render them only through referenced visible messages.

#### Scenario: Message references image file ids

- **WHEN** a visible message has image file ids and summaries exist for those file ids
- **THEN** conversation context SHALL include concise image context for that message

#### Scenario: Image summaries are missing

- **WHEN** a message references image file ids without stored summaries
- **THEN** conversation context SHALL omit image summary text rather than inventing image contents

#### Scenario: Vision backfill state exists

- **WHEN** conversation state records completed vision backfill
- **THEN** Junior MAY skip redundant hydration unless new image attachments or unhydrated messages are present

### Requirement: Thread title source

Junior SHALL derive assistant-thread titles from the earliest known human-authored message in visible conversation memory.

#### Scenario: Human messages exist

- **WHEN** Junior needs a source message for title generation
- **THEN** it SHALL choose the earliest non-bot user message by creation time and id tie-breaker

#### Scenario: Only bot-authored user messages exist

- **WHEN** visible conversation memory contains only bot-authored user messages
- **THEN** Junior SHALL NOT use those messages as the human title source

### Requirement: Conversation-state verification taxonomy

Conversation-state verification SHALL separate pure state coercion/rendering, runtime state preparation, and model interpretation.

#### Scenario: Coercion or rendering is verified

- **WHEN** verifying default state, malformed state omission, message upsert, stats, title source, visible compaction reducer behavior, or context rendering
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Runtime preparation is verified

- **WHEN** verifying Slack message backfill, queued/skipped message persistence, image hydration, active/last session pointer use, or final delivery state patches
- **THEN** the primary coverage SHALL be integration tests

#### Scenario: Model answer quality is verified

- **WHEN** verifying whether the model uses visible thread context correctly
- **THEN** verification SHALL use evals or behavior integration tests owned by turn-handling/prompt capabilities
