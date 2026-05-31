## ADDED Requirements

### Requirement: Terminal assistant output resolution

Junior SHALL resolve a turn's user-visible assistant reply from the terminal assistant state after relevant tool results have been observed.

#### Scenario: Provisional assistant text precedes tool results

- **WHEN** an assistant message appears before a later tool result and a later assistant message resolves the turn
- **THEN** Junior SHALL use the later terminal assistant message as the primary reply text
- **AND** Junior SHALL NOT post the provisional pre-tool text as the finalized answer

#### Scenario: Terminal assistant message has useful text

- **WHEN** the final assistant message after tool results contains user-facing text
- **THEN** Junior SHALL use that text as the primary thread reply unless a validated side-effect-only delivery mode suppresses it

#### Scenario: Terminal assistant message reports provider error

- **WHEN** the terminal assistant message indicates a provider error
- **THEN** Junior SHALL classify the turn as provider-error outcome
- **AND** Junior MAY include useful partial assistant text as interrupted visible output

#### Scenario: Turn has no useful assistant text or successful side effect

- **WHEN** a turn completes without user-facing assistant text, successful side effects, or deliverable files
- **THEN** Junior SHALL classify the turn as an execution failure rather than silently succeeding

### Requirement: Side-effect-only reply planning

Junior SHALL suppress redundant thread replies only when a validated Slack side effect satisfies the user-visible request.

#### Scenario: Explicit channel post succeeds

- **WHEN** the model explicitly posts the requested response to the target channel and the side effect succeeds
- **THEN** Junior SHALL plan channel-only delivery for the thread reply
- **AND** Junior SHALL NOT post an empty duplicate thread acknowledgement

#### Scenario: Reaction-only request succeeds

- **WHEN** the user requested a reaction-only action and the reaction side effect succeeds
- **THEN** Junior SHALL treat the turn as successful without posting redundant model acknowledgement text

#### Scenario: Reaction action includes meaningful reply text

- **WHEN** a reaction side effect succeeds and the terminal assistant message contains non-redundant user-facing text
- **THEN** Junior SHALL keep normal thread reply delivery enabled

#### Scenario: Side-effect validation fails

- **WHEN** reaction, channel post, canvas, or file side-effect validation fails
- **THEN** Junior SHALL NOT use the failed side effect to suppress required thread error or fallback delivery

### Requirement: File-visible reply planning

Junior SHALL preserve deliverable files as visible Slack output even when normal thread text is suppressed.

#### Scenario: Reply has text and inline files

- **WHEN** a reply includes primary text and files planned for inline delivery
- **THEN** Junior SHALL attach the files to the first planned thread reply post

#### Scenario: Reply has files but no text

- **WHEN** a reply has deliverable files and no thread text
- **THEN** Junior SHALL plan a visible file-only thread reply instead of dropping the files

#### Scenario: Reply files are planned as follow-up

- **WHEN** a reply declares follow-up file delivery
- **THEN** Junior SHALL plan a separate file follow-up stage after any text-bearing thread reply posts

#### Scenario: Channel-only reply still has files for the user

- **WHEN** thread text is suppressed by channel-only delivery but files remain deliverable in the thread
- **THEN** Junior SHALL plan a visible file delivery stage

### Requirement: Canvas and artifact reply shaping

Junior SHALL shape verbose artifact success text into concise user-facing acknowledgement when a structured artifact side effect already carries the detailed content.

#### Scenario: Canvas creation succeeds with verbose model text

- **WHEN** a canvas or comparable artifact side effect succeeds and the assistant emits verbose duplicate content
- **THEN** Junior SHALL replace the verbose text with a short acknowledgement that points the user at the created artifact when a URL is available

#### Scenario: Canvas creation succeeds without URL

- **WHEN** a canvas or comparable artifact side effect succeeds but no artifact URL is available
- **THEN** Junior SHALL still use concise acknowledgement text rather than reposting the full artifact body in thread

### Requirement: Unsafe payload suppression

Junior SHALL not expose raw execution payloads as assistant reply text.

#### Scenario: Terminal text is an execution escape

- **WHEN** the resolved terminal assistant text is a raw execution payload, tool payload, or execution escape marker
- **THEN** Junior SHALL suppress that text from user-visible reply planning
- **AND** Junior SHALL classify the turn as an execution failure unless another validated side effect satisfies the request

#### Scenario: Attachment claims are inconsistent

- **WHEN** assistant text claims an attachment or deliverable file that is not present in the planned reply files
- **THEN** Junior SHALL treat the reply as invalid rather than posting misleading attachment claims

### Requirement: Slack reply post planning

Junior SHALL convert an `AssistantReply` into ordered Slack post stages before invoking Slack API writes.

#### Scenario: Reply text exceeds one Slack post

- **WHEN** the finalized reply text must be split for Slack delivery
- **THEN** Junior SHALL plan an initial thread reply stage followed by ordered continuation stages
- **AND** Junior SHALL split only after the final reply text is known

#### Scenario: Reply text contains fenced code

- **WHEN** reply text with fenced code blocks is split into continuation posts
- **THEN** Junior SHALL preserve code-block readability across the planned post stages

#### Scenario: Reply has only files

- **WHEN** the reply contains files and no text-bearing message
- **THEN** Junior SHALL plan a file-only thread reply stage with no formatted text blocks

#### Scenario: Reply has no text and no files

- **WHEN** the reply has no text and no files after planning
- **THEN** Junior SHALL produce no Slack reply post stages

### Requirement: Final reply footer planning

Junior SHALL attach compact finalized reply metadata only where it is useful to the visible Slack reply.

#### Scenario: Reply has one text post

- **WHEN** a planned Slack reply has a single text-bearing post
- **THEN** Junior SHALL include compact footer metadata on that post when metadata is available

#### Scenario: Reply has multiple text chunks

- **WHEN** a planned Slack reply has continuation posts
- **THEN** Junior SHALL attach footer metadata to the last text-bearing chunk only

#### Scenario: Reply post is blank or file-only

- **WHEN** a planned Slack reply post has no text
- **THEN** Junior SHALL NOT add formatted text or footer blocks to that post

#### Scenario: Sentry conversation link is unavailable

- **WHEN** footer metadata lacks enough configured Sentry context to build a conversation link
- **THEN** Junior SHALL omit the Sentry footer link rather than emitting a broken or placeholder link

### Requirement: Reply-planning verification taxonomy

Reply-planning verification SHALL separate deterministic planning logic from Slack API writes and model intent behavior.

#### Scenario: Deterministic reply resolution is verified

- **WHEN** verifying terminal output selection, side-effect suppression, delivery-plan helpers, post-stage planning, unsafe payload suppression, or footer formatting
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Slack finalized delivery wiring is verified

- **WHEN** verifying finalized Slack reply delivery, chunk ordering, inline files, file-only replies, or thread-suppressed file visibility
- **THEN** the primary coverage SHALL be Slack integration tests

#### Scenario: Model-facing intent is verified

- **WHEN** verifying whether the model chooses a reaction, channel post, canvas, or thread reply for natural-language requests
- **THEN** the primary coverage SHALL be evals owned by `agent-turn-handling`, `agent-prompt`, or tool-specific capabilities rather than this deterministic planning capability
