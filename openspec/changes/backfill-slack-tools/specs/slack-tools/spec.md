## ADDED Requirements

### Requirement: Slack tool availability

Junior SHALL expose Slack tools according to active Slack context and channel capabilities.

#### Scenario: Shared channel context is active

- **WHEN** the active Slack conversation supports channel-scope operations
- **THEN** Junior SHALL expose channel post, channel history, reaction, and canvas creation tools

#### Scenario: DM context is active

- **WHEN** the active Slack conversation is a DM
- **THEN** Junior SHALL omit channel broadcast/history tools
- **AND** Junior MAY expose reaction and canvas creation tools when the runtime can target the current DM context safely

#### Scenario: No Slack channel context is active

- **WHEN** no active Slack channel context exists
- **THEN** Junior SHALL omit context-bound Slack side-effect tools

### Requirement: Context-bound Slack targets

Junior SHALL bind Slack side-effect tools to runtime-provided targets rather than model-provided destinations.

#### Scenario: Reaction tool is called

- **WHEN** the model calls the reaction tool
- **THEN** Junior SHALL target the active inbound Slack message timestamp in the active channel
- **AND** the tool schema SHALL NOT expose arbitrary channel or message target fields

#### Scenario: Channel post tool is called

- **WHEN** the model calls the channel-post tool
- **THEN** Junior SHALL post to the active channel context outside the thread
- **AND** the tool schema SHALL NOT expose arbitrary destination channel fields

#### Scenario: List follow-up tool is called

- **WHEN** the model calls list add, get, or update tools
- **THEN** Junior SHALL resolve the target list from artifact state rather than model-provided `list_id`

#### Scenario: Required context is missing

- **WHEN** a context-bound Slack tool lacks required channel, message timestamp, or artifact state
- **THEN** Junior SHALL surface a model-repairable failure and SHALL NOT silently retarget to another Slack surface

### Requirement: Slack reaction tool

Junior SHALL provide a bounded reaction tool for lightweight current-message acknowledgement.

#### Scenario: Emoji alias includes surrounding colons

- **WHEN** the reaction tool receives a Slack emoji alias with optional surrounding colons
- **THEN** Junior SHALL normalize it before calling Slack

#### Scenario: Emoji alias is invalid

- **WHEN** the reaction tool receives an invalid Slack emoji alias
- **THEN** Junior SHALL surface a model-repairable failure

#### Scenario: Same reaction is repeated in one turn

- **WHEN** the same reaction operation is requested more than once in one turn
- **THEN** Junior SHALL reuse the turn-local cached result rather than repeating the Slack side effect

### Requirement: Slack channel post tool

Junior SHALL provide an explicit channel-post tool only for user-requested in-channel messages.

#### Scenario: Channel post succeeds

- **WHEN** the channel-post tool succeeds
- **THEN** Junior SHALL return the posted channel ID, timestamp, and permalink when available
- **AND** reply planning MAY suppress duplicate thread text according to `reply-planning`

#### Scenario: Channel post is repeated in one turn

- **WHEN** the same channel-post operation is requested more than once in one turn
- **THEN** Junior SHALL reuse the turn-local cached result rather than posting duplicate messages

#### Scenario: Model wants a normal thread reply

- **WHEN** the request can be answered by the normal finalized thread reply
- **THEN** the model SHOULD NOT call the channel-post tool

### Requirement: Slack channel and thread read tools

Junior SHALL expose Slack history reads that return safe, bounded context without leaking private file URLs.

#### Scenario: Channel history is read

- **WHEN** the channel-history tool reads recent messages
- **THEN** Junior SHALL target the active channel context and return bounded message data with pagination information when available

#### Scenario: Channel history cursor is invalid

- **WHEN** Slack rejects a history cursor as invalid
- **THEN** Junior SHALL surface a model-visible retry instruction to restart without the cursor

#### Scenario: Thread read receives Slack message URL

- **WHEN** the thread-read tool receives a Slack archive URL
- **THEN** Junior SHALL parse the channel ID and message timestamp from the URL before reading the thread

#### Scenario: Thread read targets private channel or DM

- **WHEN** the requested thread is in a private channel or DM other than the current conversation
- **THEN** Junior SHALL refuse the read without trying to bypass Slack visibility

#### Scenario: Thread messages contain files or legacy attachments

- **WHEN** thread-read returns messages with files or legacy attachments
- **THEN** Junior SHALL return safe file metadata and bounded rendered attachment text
- **AND** Junior SHALL strip private file URLs and secret-bearing fields

### Requirement: Slack canvas tools

Junior SHALL expose Slack canvas tools as document-style tools with active-context creation and handle-based read/edit/write.

#### Scenario: Canvas create succeeds

- **WHEN** the canvas-create tool creates a canvas in an active conversation context
- **THEN** Junior SHALL grant active conversation access when supported, store last/recent canvas artifact state, and return canvas ID and permalink when available

#### Scenario: Canvas content uses unsupported deep headings

- **WHEN** canvas markdown includes headings deeper than Slack Canvas supports
- **THEN** Junior SHALL normalize those headings into supported heading depth before writing

#### Scenario: Canvas read target is invalid

- **WHEN** canvas read/edit/write cannot parse a canvas/file ID or Slack canvas URL
- **THEN** Junior SHALL surface a model-repairable failure

#### Scenario: Canvas read succeeds

- **WHEN** canvas read succeeds
- **THEN** Junior SHALL verify Slack metadata describes a Canvas document and return bounded markdown content with line metadata

#### Scenario: Canvas edit succeeds

- **WHEN** canvas edit receives exact unique non-overlapping replacements
- **THEN** Junior SHALL apply them against current canvas markdown, write the updated markdown, patch artifact state, and return a compact diff

#### Scenario: Canvas write succeeds

- **WHEN** canvas write deliberately replaces a canvas body
- **THEN** Junior SHALL write normalized markdown and patch artifact state

### Requirement: Slack list tools

Junior SHALL expose Slack list tools for structured task tracking through artifact state.

#### Scenario: List create succeeds

- **WHEN** the list-create tool succeeds
- **THEN** Junior SHALL store the list ID, permalink, and column map in artifact state

#### Scenario: List add items succeeds

- **WHEN** list add receives task titles and an active list exists
- **THEN** Junior SHALL create bounded list items with optional assignee and due date fields using Slack List rich field payloads

#### Scenario: List get items succeeds

- **WHEN** list get is called with an active list
- **THEN** Junior SHALL return bounded item IDs and fields

#### Scenario: List update item succeeds

- **WHEN** list update receives an item ID and title or completion update
- **THEN** Junior SHALL update that item in the active list and patch artifact state

#### Scenario: List follow-up lacks active list

- **WHEN** list add, get, or update is called without active list artifact state
- **THEN** Junior SHALL surface a model-repairable failure

### Requirement: Slack side-effect idempotency

Junior SHALL deduplicate repeated identical Slack side-effect tool operations within a turn.

#### Scenario: Canvas or list creation repeats

- **WHEN** an identical canvas or list creation operation repeats in one turn
- **THEN** Junior SHALL return the cached result with dedupe indication rather than repeating the Slack API side effect

#### Scenario: List item operation repeats

- **WHEN** an identical list add or update operation repeats in one turn
- **THEN** Junior SHALL return the cached result rather than repeating item creation or update

#### Scenario: Later turn repeats action

- **WHEN** a later turn repeats a previously deduped Slack action
- **THEN** Junior SHALL treat it as a new operation unless a future durable idempotency spec says otherwise

### Requirement: Slack-tools verification taxonomy

Slack-tools verification SHALL separate deterministic tool constraints, Slack API contracts, and model-facing tool-use quality.

#### Scenario: Tool schemas and local validation are verified

- **WHEN** verifying context gating, target omission from schemas, ID parsing, markdown normalization, emoji normalization, or artifact-state patching
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Slack API wiring is verified

- **WHEN** verifying actual Slack API methods, request targets, MSW request shape, side-effect dedupe, or Slack failure recovery
- **THEN** the primary coverage SHALL be integration tests using the Slack HTTP harness

#### Scenario: Model chooses Slack tools

- **WHEN** verifying whether the model chooses a reaction, channel post, canvas, or list for a natural-language request
- **THEN** the primary coverage SHALL be evals owned by agent behavior/tool-family scenarios
