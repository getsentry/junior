## ADDED Requirements

### Requirement: Inbound attachment normalization

Junior SHALL preserve user-provided Slack attachment facts across ingress, queueing, and runtime preparation.

#### Scenario: Slack message includes file or image attachments

- **WHEN** Slack ingress receives a message with file or image metadata
- **THEN** Junior SHALL normalize the attachments into the Chat SDK message shape with media type, filename, and a recoverable private-file fetch path when available

#### Scenario: Edited Slack message includes file attachments

- **WHEN** a supported `message_changed` event contains file metadata
- **THEN** Junior SHALL preserve the edited message attachments for later routing and runtime context

#### Scenario: Queued message is deserialized

- **WHEN** a queued or skipped message is restored after serialization stripped function-valued fetchers
- **THEN** Junior SHALL rehydrate private-file fetchers from stored private URLs before runtime attachment resolution

#### Scenario: Attachment metadata is persisted to conversation state

- **WHEN** a user message with attachments is persisted
- **THEN** Junior SHALL store bounded attachment counts, image attachment counts, Slack timestamp, and image hydration status
- **AND** Junior SHALL NOT persist private file URLs, OAuth tokens, or raw file bytes in conversation state

### Requirement: Legacy Slack attachment text context

Junior SHALL convert text-bearing legacy Slack attachment payloads into bounded conversation text.

#### Scenario: Message text is empty but legacy attachment has fallback text

- **WHEN** a Slack message has no normal text and a legacy attachment has fallback or rich text fields
- **THEN** Junior SHALL include bounded attachment text in the normalized user-message context

#### Scenario: Legacy attachment has rich fields

- **WHEN** a Slack legacy attachment includes title, title link, text, fields, author, or footer
- **THEN** Junior SHALL render useful text fields once and drop interactive/noisy fields

#### Scenario: Legacy attachment text is too large

- **WHEN** rendered legacy attachment text exceeds the configured attachment context budget
- **THEN** Junior SHALL truncate it before adding it to conversation context

### Requirement: Current-turn attachment resolution

Junior SHALL resolve current user attachments into bounded agent input before the agent turn runs.

#### Scenario: Image attachment is present and vision is enabled

- **WHEN** the current user message includes an image attachment and a vision model is configured
- **THEN** Junior SHALL obtain image bytes from the attachment fetcher or inline data
- **AND** Junior SHALL summarize the image into concise prompt text before invoking the main agent

#### Scenario: Image summary is cached for the current message

- **WHEN** conversation vision cache already contains a summary for the current message's image file at the same attachment position
- **THEN** Junior SHALL reuse the cached summary instead of downloading or re-analyzing the image

#### Scenario: Non-image attachment is present

- **WHEN** the current user message includes a non-image file attachment with available bytes within the configured size budget
- **THEN** Junior SHALL pass the bounded file data, media type, and filename to the agent context

#### Scenario: Non-image attachment is unavailable or oversized

- **WHEN** a non-image attachment cannot be fetched or exceeds the configured size budget
- **THEN** Junior SHALL skip that attachment without failing the whole turn

#### Scenario: Image attachment analysis fails

- **WHEN** an image attachment requires analysis and Junior cannot obtain or summarize it
- **THEN** Junior SHALL fail before invoking the main agent and deliver the normal fallback-error path

### Requirement: Vision-disabled image handling

Junior SHALL treat image attachments as known omitted context when image analysis is unavailable.

#### Scenario: Vision model is unset

- **WHEN** a user message includes image attachments and no vision model is configured
- **THEN** Junior SHALL NOT fetch image bytes
- **AND** Junior SHALL pass an omitted-image count into the agent context

#### Scenario: Only images are attached and vision is disabled

- **WHEN** the user sends only image attachments and asks about them while vision is disabled
- **THEN** Junior SHALL still run the agent with omitted-image context
- **AND** the reply SHALL be able to state that images were received but cannot be analyzed

#### Scenario: Resumed turn has unhydrated image metadata

- **WHEN** a resumed turn reconstructs context from the persisted user message and images were not hydrated
- **THEN** Junior SHALL reconstruct the omitted-image count from persisted image attachment metadata

### Requirement: Conversation image hydration

Junior SHALL hydrate reusable thread image summaries from Slack thread file metadata when vision is enabled.

#### Scenario: Conversation has unhydrated human image messages

- **WHEN** a turn starts with unhydrated human messages that may have image attachments
- **THEN** Junior SHALL fetch relevant Slack thread replies and identify matching image files by Slack timestamp

#### Scenario: Image file already has cached summary

- **WHEN** a matching Slack image file ID already exists in the vision cache
- **THEN** Junior SHALL mark the message hydrated without re-downloading or re-analyzing the file

#### Scenario: Image file has no cached summary

- **WHEN** a matching Slack image file has a private download URL and is within the configured size budget
- **THEN** Junior SHALL download the file, summarize it with the vision model, store the summary by Slack file ID, and mark the message hydrated

#### Scenario: Image file is missing URL or exceeds size budget

- **WHEN** a matching Slack image file lacks a private download URL or exceeds the configured size budget
- **THEN** Junior SHALL skip that file without storing raw bytes or a private URL

#### Scenario: Passive skipped screenshot is later referenced

- **WHEN** a passive subscribed-thread message with an image was preserved but skipped and a later explicit mention asks about it
- **THEN** Junior SHALL hydrate the earlier image if recoverable and include its summary in conversation context

### Requirement: Slack file metadata incompleteness

Junior SHALL tolerate Slack file events whose metadata is incomplete at ingress time.

#### Scenario: Slack event contains file identifier but not full metadata

- **WHEN** Slack provides a file object that requires a later metadata lookup before private URL or MIME type is available
- **THEN** Junior SHALL preserve enough file identity to allow later recovery when supported
- **AND** Junior SHALL NOT pretend the file was analyzed from unavailable metadata

#### Scenario: File metadata remains unavailable

- **WHEN** Junior cannot recover enough metadata or bytes for an attachment
- **THEN** Junior SHALL omit that attachment from model input or report known omitted context according to attachment type

### Requirement: Attachment context prompt projection

Junior SHALL project resolved attachment context into model input without leaking unsafe raw platform data.

#### Scenario: Attachment has text prompt summary

- **WHEN** an attachment is represented by a vision summary or other prompt text
- **THEN** Junior SHALL pass that summary as text content and routing context rather than raw private URL data

#### Scenario: Attachment has supported text preview

- **WHEN** a non-image attachment has bytes with a supported text-preview media type
- **THEN** Junior SHALL include a bounded text preview in routing context

#### Scenario: Attachment has binary bytes

- **WHEN** a non-image attachment has binary bytes without supported text preview
- **THEN** Junior SHALL preserve the file metadata in context and avoid adding unreadable binary text to routing context

### Requirement: Attachment-and-vision verification taxonomy

Attachment-and-vision verification SHALL separate pure transforms from Slack runtime wiring and model-facing answer quality.

#### Scenario: Pure attachment transforms are verified

- **WHEN** verifying legacy attachment rendering, attachment-claim truth, count reconstruction, or text-preview formatting
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Slack attachment runtime wiring is verified

- **WHEN** verifying Slack file ingress, queue fetcher rehydration, image hydration, skipped passive screenshots, DM file-share events, or mixed media behavior
- **THEN** the primary coverage SHALL be Slack integration tests

#### Scenario: Attachment answer quality is verified

- **WHEN** verifying whether the model gives a good answer from image summaries or omitted-image notices
- **THEN** the primary coverage SHALL be evals owned by agent behavior capabilities rather than this deterministic context capability
