## ADDED Requirements

### Requirement: Session identity and state partition

Junior SHALL identify reusable conversation history, projection sessions, resumable turns, and execution slices while keeping agent session state separate from Slack/thread runtime state.

#### Scenario: A turn starts in a thread

- **WHEN** Junior starts an assistant turn for a Slack thread
- **THEN** Junior SHALL derive a stable `conversation_id` for the thread, use the current conversation-local `session_id` for the active reduced projection, derive a distinct `turn_id` for pause/resume correlation, and use a monotonic `slice_id` starting at `1` for resumed execution chunks

#### Scenario: Compaction resets projection

- **WHEN** compaction or recovery appends a projection-reset entry
- **THEN** Junior SHALL advance the conversation-local `session_id`
- **AND** later projection and derived runtime-handle reducers SHALL ignore older entries from prior session markers unless a caller explicitly asks for that historical session

#### Scenario: Session state is persisted

- **WHEN** Junior persists model execution history for a turn
- **THEN** Junior SHALL store canonical Pi-message history in Junior-owned agent session storage rather than in Chat SDK queue/cache state

#### Scenario: Runtime state changes mid-slice

- **WHEN** artifact state, sandbox identity, pending auth, visible conversation state, or channel configuration changes
- **THEN** Junior SHALL persist or reload those facts through their owning thread/configuration services instead of duplicating them as opaque session-log metadata

#### Scenario: Transitional read model exists

- **WHEN** Junior uses a versioned turn-session record to validate callbacks or materialize lifecycle state
- **THEN** that record SHALL be treated as a projection/read model over committed session history, not as a second durable transcript

### Requirement: Append-only session log and Pi projection

Junior SHALL represent resumable model history as an append-only log with deterministic projection into Pi messages.

#### Scenario: Pi history grows

- **WHEN** new Pi messages extend the current projection
- **THEN** Junior SHALL append only the new Pi-message entries needed to materialize that projection

#### Scenario: Safe projection rolls back

- **WHEN** recovery trims or branches from an earlier safe boundary
- **THEN** Junior SHALL append a projection-reset entry instead of rewriting or deleting existing session-log entries

#### Scenario: Junior-only event is reduced

- **WHEN** a session-log entry records a Junior runtime fact such as a connected MCP provider
- **THEN** Junior SHALL reduce that fact for runtime restoration and SHALL filter it out before assigning Pi-visible messages

#### Scenario: Stored entry is invalid

- **WHEN** stored session-log data cannot be parsed as a supported schema entry or legacy Pi message
- **THEN** Junior SHALL fail loudly rather than guessing a projection

### Requirement: Safe pause boundaries

Junior SHALL create resumable pause boundaries only at Pi states that can be continued without duplicating unsafe partial work.

#### Scenario: Boundary ends in user or tool result

- **WHEN** the latest Pi projection ends with a user message or tool-result message
- **THEN** Junior MAY persist that projection as a safe running, timeout, or auth boundary

#### Scenario: Boundary has trailing assistant-only text

- **WHEN** a timeout or auth pause captures trailing assistant-only output
- **THEN** Junior SHALL trim the unsafe assistant tail and fall back to the latest stored safe boundary before marking the session awaiting resume

#### Scenario: Boundary is empty or non-continuable

- **WHEN** Junior cannot materialize a non-empty continuable Pi boundary
- **THEN** Junior SHALL NOT create an awaiting-resume session record for that pause

#### Scenario: Tool call is in flight

- **WHEN** Pi has emitted a tool request and the corresponding tool result has not been durably recorded
- **THEN** Junior SHALL NOT treat that point as a safe automatic resume boundary

### Requirement: Pi resume execution

Junior SHALL restore Pi runtime state from durable projection before resuming an interrupted assistant turn.

#### Scenario: Awaiting session resumes

- **WHEN** Junior loads an awaiting-resume session record with committed Pi messages
- **THEN** Junior SHALL instantiate the agent, restore runtime handles, assign `agent.state.messages` from the projected messages, and call `continue()`

#### Scenario: Fresh turn has prior session history

- **WHEN** a later turn in the same conversation needs prior model history
- **THEN** Junior SHALL load the materialized session projection instead of relying only on conversation-state transcript mirroring

#### Scenario: Session bootstrap context is persisted once

- **WHEN** Junior persists completed Pi messages for a session projection
- **THEN** Junior MAY retain the session bootstrap context attached to the first model-visible user message
- **AND** later ordinary follow-up user messages in the same projection SHALL NOT duplicate that bootstrap context

#### Scenario: Projection has no bootstrap context

- **WHEN** the reduced Pi projection has no session bootstrap context because the conversation is new, the projection was compacted, or the session is being resumed from an explicit read model boundary
- **THEN** Junior SHALL attach fresh bootstrap context before the next model-visible user input or continuation

#### Scenario: Runtime context must be refreshed

- **WHEN** a resumed slice needs current turn context or configuration
- **THEN** Junior SHALL refresh that context from canonical services before continuing Pi

### Requirement: Timeout pause and automatic continuation

Junior SHALL handle turn timeouts as bounded, best-effort automatic continuation when no visible assistant output has started.

#### Scenario: Agent slice times out before final delivery

- **WHEN** a slice times out and Junior can persist a safe boundary
- **THEN** Junior SHALL mark the session as awaiting timeout resume, increment the next slice id, and raise a retryable timeout error carrying resume correlation

#### Scenario: Timeout boundary cannot be persisted

- **WHEN** timeout pause persistence fails or no safe boundary exists
- **THEN** Junior SHALL fall back to normal non-resumable turn failure behavior

#### Scenario: Automatic continuation is within depth limit

- **WHEN** an awaiting timeout resume has a next slice id inside the configured automatic continuation limit
- **THEN** Junior MAY schedule a signed internal timeout-resume callback for that session

#### Scenario: Automatic continuation exceeds depth limit

- **WHEN** the next slice id exceeds the automatic continuation limit
- **THEN** Junior SHALL stop scheduling automatic continuation and let failure delivery own user-visible recovery

#### Scenario: User follows up while continuation is awaiting

- **WHEN** a later user message reaches a thread whose active turn is awaiting timeout continuation
- **THEN** Junior SHALL treat the message as a retry signal for the existing session instead of starting a second visible turn

### Requirement: Signed timeout-resume callback

Junior SHALL authenticate and validate internal timeout-resume callbacks before resuming work.

#### Scenario: Callback is missing or tampered

- **WHEN** the timeout-resume request lacks a valid signature, timestamp, secret, or parseable payload
- **THEN** Junior SHALL reject the request without scheduling resume work

#### Scenario: Callback is stale

- **WHEN** the callback no longer matches an awaiting timeout-resume session projection
- **THEN** Junior SHALL exit without doing resume work

#### Scenario: Callback is valid

- **WHEN** the callback matches an awaiting timeout-resume session
- **THEN** Junior SHALL rebuild runtime state from durable thread/configuration/session state and resume under the same logical conversation lock

#### Scenario: Resume lock is busy

- **WHEN** the timeout-resume callback races another holder of the conversation lock
- **THEN** Junior SHALL retry briefly and then reschedule the same continuation request instead of abandoning the awaiting session

#### Scenario: Resumed slice times out again

- **WHEN** a resumed timeout slice reaches another safe timeout boundary within the depth limit
- **THEN** Junior SHALL schedule another callback for the newer session version or pause boundary

### Requirement: Authorization interrupt event history

Junior SHALL model plugin and MCP authorization pauses as host-owned session-log interrupt events, not as prompt-side lifecycle flags.

#### Scenario: Authorization link is delivered or reused

- **WHEN** Junior privately delivers or reuses an authorization link for auth-gated plugin or MCP work
- **THEN** Junior SHALL append `authorization_requested` with `kind`, `provider`, `requesterId`, `authorizationId`, and `delivery`
- **AND** `kind` SHALL be `plugin` or `mcp`
- **AND** `delivery` SHALL be `private_link_sent` or `private_link_reused`
- **AND** the event SHALL NOT include authorization URLs, tokens, OAuth codes, refresh tokens, client secrets, or scopes unless scope-level model behavior is separately specified

#### Scenario: Authorization callback completes

- **WHEN** an OAuth or MCP callback validates state and stores credentials for the blocked requester and provider
- **THEN** Junior SHALL append `authorization_completed` with `kind`, `provider`, `requesterId`, and `authorizationId` before resuming the agent session
- **AND** the event SHALL NOT include authorization URLs, tokens, OAuth codes, refresh tokens, client secrets, or scopes unless scope-level model behavior is separately specified

#### Scenario: Authorization completion is projected

- **WHEN** Junior materializes Pi history for a resumed session containing an `authorization_completed` event
- **THEN** Junior SHALL deterministically project exactly one host-authored, internal observation in chronological order telling the agent that authorization completed for the provider and that it should continue the blocked request and retry the provider operation if needed
- **AND** that observation SHALL NOT be treated as a Slack user message

#### Scenario: Prompt context is built for an auth resume

- **WHEN** Junior builds per-turn prompt context for an auth-resumed turn
- **THEN** Junior SHALL NOT inject `pendingAuth`, `<turn-state>resumed</turn-state>`, `authorization_completed_provider`, or equivalent auth lifecycle prompt flags
- **AND** model-visible authorization completion SHALL come from session-history projection

#### Scenario: Thread pending auth exists

- **WHEN** thread-local `pendingAuth` exists
- **THEN** Junior SHALL use it only for callback routing, deduplication, and stale-resume suppression, not as model-visible state

### Requirement: Auth pause and authorization resume

Junior SHALL use the same session continuation model for authorization pauses while keeping callback routing state separate from canonical agent session history.

#### Scenario: Auth pause occurs

- **WHEN** an MCP or plugin tool requires user authorization at a safe boundary
- **THEN** Junior SHALL persist an awaiting auth resume session with a continuable Pi projection, append the authorization interrupt event, and record auth-owned callback routing state

#### Scenario: Auth callback resumes current work

- **WHEN** authorization completes for the current awaiting session
- **THEN** Junior SHALL reload thread state, pending auth routing state, requester context, configuration, artifacts, sandbox state, and Pi/session-log projection before continuing the same session

#### Scenario: Auth callback is stale

- **WHEN** authorization completes after the session was completed, failed, abandoned, or superseded by newer user input
- **THEN** Junior SHALL store credentials as appropriate but SHALL NOT post a stale resumed answer

#### Scenario: Auth resume pauses again

- **WHEN** a resumed auth slice pauses for another auth or timeout boundary
- **THEN** Junior SHALL persist the new safe boundary and route continuation according to the new pause reason

### Requirement: Runtime handle restoration

Junior SHALL restore model-visible runtime handles from durable history before resumed execution needs them.

#### Scenario: Skill was loaded earlier

- **WHEN** durable Pi history shows a successful skill load
- **THEN** Junior SHALL restore the active skill before prompt construction or continuation

#### Scenario: MCP provider was connected earlier

- **WHEN** the session log records a connected MCP provider or legacy Pi history implies an active provider during migration
- **THEN** Junior SHALL reactivate that provider and expose its tools before continuing Pi

#### Scenario: Provider is newly connected

- **WHEN** Junior successfully connects and lists a provider's tools during a session
- **THEN** Junior SHALL record that provider once as a Junior-only session fact

#### Scenario: Artifact or sandbox handle is needed

- **WHEN** resumed tools need prior artifact state or sandbox identity
- **THEN** Junior SHALL restore those handles from durable thread state rather than from model history

### Requirement: Provider retry before delivery

Junior SHALL retry transient provider failures only from safe Pi boundaries and only before visible final delivery begins.

#### Scenario: Provider returns transient terminal assistant error

- **WHEN** the latest assistant message represents a retryable provider failure and no visible final reply has been delivered
- **THEN** Junior MAY trim the assistant error tail, append a projection reset for the safe boundary, wait with bounded backoff, and call `continue()`

#### Scenario: Provider retry has no safe boundary

- **WHEN** trimming the provider error tail does not leave a continuable user or tool-result boundary
- **THEN** Junior SHALL stop retrying and let normal provider-failure reply handling own recovery

#### Scenario: Provider retry limit is reached

- **WHEN** the bounded retry limit is exhausted
- **THEN** Junior SHALL stop retrying and continue through normal failure handling

### Requirement: Resume completion and failure finalization

Junior SHALL commit resumed-session success only after final visible delivery and SHALL terminalize failed resumptions deterministically.

#### Scenario: Resumed reply is delivered

- **WHEN** Slack accepts the final visible resumed reply
- **THEN** Junior SHALL persist delivered conversation/thread state and mark the session completed

#### Scenario: Final resumed delivery fails

- **WHEN** Slack rejects the final visible resumed reply
- **THEN** Junior SHALL treat the resume as failed and SHALL NOT mark state as delivered

#### Scenario: Post-delivery commit fails

- **WHEN** Slack accepted the resumed reply but completion state could not be persisted
- **THEN** Junior SHALL mark or attempt to mark the session failed for operator visibility and surface the persistence failure

#### Scenario: Resume cannot continue

- **WHEN** a resume handler reaches terminal failure before final delivery
- **THEN** Junior SHALL mark the turn/session failed and clear or update active turn state so the thread is not left permanently blocked

### Requirement: Resumability verification taxonomy

Agent session resumability verification SHALL separate pure session mechanics, runtime resume wiring, and model-visible continuity.

#### Scenario: Reducer or signature behavior is verified

- **WHEN** the requirement concerns session-log projection, safe-boundary trimming, callback signing, or depth checks
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Runtime resume wiring is verified

- **WHEN** the requirement concerns Slack/thread state reconstruction, final delivery, locks, callback retries, or auth callback behavior
- **THEN** the primary coverage SHALL be integration tests

#### Scenario: Natural-language continuity is verified

- **WHEN** the requirement concerns whether the resumed agent uses prior thread context correctly in its answer
- **THEN** the primary coverage SHALL be an eval
