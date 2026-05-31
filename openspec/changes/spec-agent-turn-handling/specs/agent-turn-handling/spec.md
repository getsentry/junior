## ADDED Requirements

### Requirement: Active user requests

Junior SHALL treat direct messages, explicit mentions, and Slack assistant/app-thread user-message events as active requests that are eligible for a reply without passive subscribed-thread classification. Slack assistant lifecycle events are setup/context events, not user-message turns.

#### Scenario: Direct message asks for help

- **WHEN** a user sends Junior a direct message asking for work or information
- **THEN** Junior SHALL handle the message as an active turn and produce a final user-facing answer unless the turn pauses, fails, or is genuinely blocked

#### Scenario: Channel mention asks Junior to act

- **WHEN** a user mentions Junior in a channel or thread and gives an instruction
- **THEN** Junior SHALL bypass passive no-reply routing, subscribe to the thread when applicable, and handle the message as an active turn

#### Scenario: Assistant lifecycle event initializes context

- **WHEN** Slack sends an assistant-thread lifecycle event without a user-authored message
- **THEN** Junior SHALL initialize or refresh assistant-thread metadata without running a normal assistant answer

#### Scenario: Explicit mention contains stop instruction

- **WHEN** a user explicitly tells Junior to stop watching, replying, or participating in a subscribed thread
- **THEN** Junior SHALL unsubscribe from the thread, acknowledge the opt-out, and not run a normal assistant answer for that message

### Requirement: Passive subscribed-thread participation

Junior SHALL treat subscribed Slack threads as passive by default and reply only when the latest user message is directed back to Junior. Attachments are routing context and answer context, not an automatic reason to reply.

#### Scenario: Human side conversation

- **WHEN** a subscribed thread receives a user message addressed to another person or continuing human-to-human coordination
- **THEN** Junior SHALL skip the reply and persist enough message context for future turns

#### Scenario: Acknowledgement only

- **WHEN** a subscribed thread receives a message such as "thanks", "got it", "sounds good", or equivalent acknowledgement without an explicit ask
- **THEN** Junior SHALL skip the reply

#### Scenario: Immediate terse clarification

- **WHEN** Junior was the last speaker and the next user message is a terse clarification such as "why?", "which one?", or "say more"
- **THEN** Junior SHALL treat the message as an implicit follow-up and answer in the thread

#### Scenario: Low-confidence passive routing

- **WHEN** subscribed-thread routing cannot confidently determine that the latest message is for Junior
- **THEN** Junior SHALL prefer staying silent over interrupting the thread

#### Scenario: Attachment-only passive message

- **WHEN** a subscribed thread receives an attachment-only or attachment-backed message without an explicit mention
- **THEN** Junior SHALL route the message with attachment context and SHALL NOT reply solely because an attachment exists

### Requirement: Self-message loop prevention

Junior SHALL avoid responding to messages authored by itself so Slack delivery, retries, and bot-authored follow-ups do not create reply loops.

#### Scenario: Junior-authored message is observed

- **WHEN** Junior observes a message whose author is Junior itself
- **THEN** Junior SHALL not start a normal assistant turn for that message

### Requirement: Queued and skipped user input

Junior SHALL preserve user-authored messages that arrive while a turn is active and include them in the next handled turn according to the Chat SDK queue contract.

#### Scenario: Multiple messages arrive during an active turn

- **WHEN** users send one or more messages while the per-thread handler is still processing an earlier message
- **THEN** Junior SHALL combine the queued user text with the dispatched message text for the next eligible turn

#### Scenario: Skipped passive message later becomes relevant

- **WHEN** Junior skips a passive subscribed-thread message and a later explicit mention asks about the same thread context
- **THEN** Junior SHALL make the skipped message available as prior conversation context when building the later turn

### Requirement: In-turn execution policy

Junior SHALL satisfy actionable requests in the current turn by using available context, skills, and tools before asking the user for help or ending with a plan.

#### Scenario: Actionable request has available tools

- **WHEN** the user asks Junior to inspect, change, verify, search, post, react, or otherwise act and the required tool or source is available
- **THEN** Junior SHALL use the tool or source in the same turn and answer with the result

#### Scenario: Missing access or required decision

- **WHEN** Junior cannot safely continue because required access, approval, or a user decision is missing
- **THEN** Junior SHALL ask one focused clarifying or approval question instead of guessing

#### Scenario: Mutable or current fact

- **WHEN** the user asks about a mutable fact, current state, repository contents, provider state, or a user-provided source
- **THEN** Junior SHALL verify against the nearest authoritative available source before answering

### Requirement: Thread continuity and role attribution

Junior SHALL interpret the latest user message in the context of the Slack thread while preserving who is asking now versus who authored prior context.

#### Scenario: Follow-up references prior answer

- **WHEN** the user asks a follow-up that depends on Junior's prior thread answer
- **THEN** Junior SHALL answer from prior thread context without repeating already resolved clarifying questions

#### Scenario: Requester differs from original reporter

- **WHEN** a different user asks a follow-up in the same Slack thread
- **THEN** Junior SHALL treat the current user as the requester while preserving attribution for earlier messages and subjects

### Requirement: Slack side-effect intent

Junior SHALL use Slack side-effect tools only when the user explicitly requests the side effect, and SHALL not claim success unless the tool succeeded in the current turn.

#### Scenario: User asks Junior to post in channel

- **WHEN** the user explicitly asks Junior to post, send, say, or share a message in the current Slack channel
- **THEN** Junior SHALL use the channel-post tool when the runtime provides a valid target and SHALL not use a normal thread reply as a substitute for the requested channel post

#### Scenario: User asks Junior to react

- **WHEN** the user explicitly asks Junior to add a Slack reaction
- **THEN** Junior SHALL use the Slack reaction tool when the runtime provides a valid target and SHALL not treat automatic processing reactions as satisfying the user's request

#### Scenario: Slack side effect satisfies the turn

- **WHEN** a successful Slack side-effect tool already satisfies the user's request and a duplicate thread reply would only restate the same acknowledgement
- **THEN** Junior MAY suppress the duplicate final thread text according to the reply-delivery plan

### Requirement: Progress and resumed-turn behavior

Junior SHALL keep long-running Slack turns visibly alive through runtime-owned progress surfaces and SHALL avoid duplicating runtime continuation or authorization notices in model-authored final replies.

#### Scenario: Non-trivial long-running work

- **WHEN** a turn requires non-trivial multi-step work
- **THEN** Junior SHALL emit progress through the runtime progress mechanism when available and reserve final answer text for the completed result

#### Scenario: Authorization pause resumes

- **WHEN** a turn resumes after an authorization pause
- **THEN** Junior SHALL continue the pending user request from durable session history and answer with the final requested content only

#### Scenario: Timeout continuation resumes

- **WHEN** a turn resumes after a timeout continuation notice
- **THEN** Junior SHALL continue the same pending turn and not apologize for or repeat the runtime continuation notice unless the final answer needs to explain an actual blocker

### Requirement: Attachments and unavailable vision

Junior SHALL treat Slack attachments as part of the user turn and SHALL distinguish unavailable analysis capability from absent attachments.

#### Scenario: Text or file attachment included

- **WHEN** a Slack message includes text, files, or attachment metadata that can be converted into prompt context
- **THEN** Junior SHALL use that attachment context when deciding and answering the turn

#### Scenario: Image analysis unavailable

- **WHEN** Slack delivered image attachments but the configured runtime cannot analyze images
- **THEN** Junior SHALL say image analysis is unavailable if the image contents are relevant, and SHALL NOT claim that no image was attached

### Requirement: Turn completion

Junior SHALL consider a user turn complete only when the user's actual request has a final outcome: answered, satisfied by a successful side effect, paused for runtime-owned continuation/auth, explicitly blocked, or failed with an actionable fallback.

#### Scenario: Normal answer

- **WHEN** Junior completes model/tool execution and final Slack delivery accepts the visible reply
- **THEN** Junior SHALL mark the turn as completed and persist the assistant message as visible conversation state

#### Scenario: Tool or provider failure

- **WHEN** a tool, provider, or runtime failure prevents the requested work from completing
- **THEN** Junior SHALL either recover within the turn, pause through the appropriate runtime mechanism, or provide an explicit user-visible failure response

#### Scenario: Final answer cannot be empty

- **WHEN** a turn does not produce a successful side effect, file-only reply, pause notice, or non-empty assistant answer
- **THEN** Junior SHALL deliver an explicit fallback response rather than silently completing the turn
