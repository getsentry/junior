## ADDED Requirements

### Requirement: Live thread queue configuration

Junior SHALL use a per-thread queue for production Slack message handling so one normalized Slack thread has at most one live handler at a time.

#### Scenario: Production bot is created

- **WHEN** Junior creates the production Slack chat app
- **THEN** it SHALL configure Chat SDK concurrency with `strategy="queue"`

#### Scenario: Queue entry TTL is configured

- **WHEN** Junior configures queue entry TTL for Slack message delivery
- **THEN** the TTL SHALL exceed the maximum expected live turn duration so follow-up messages do not expire while a long turn holds the thread handler

#### Scenario: Thread id is normalized

- **WHEN** Slack ingress computes the queue key
- **THEN** it SHALL use the normalized Slack thread id defined by `slack-ingress-routing`

### Requirement: Queued and skipped message preservation

Junior SHALL consume queued/skipped user messages as user-authored input for the next eligible turn.

#### Scenario: Messages arrive during an active handler

- **WHEN** Chat SDK dispatches a later message and provides earlier queued messages as skipped context
- **THEN** Junior SHALL include those skipped messages in the next runtime turn input and visible conversation state

#### Scenario: Queued message attachments were serialized

- **WHEN** a queued message attachment has a private URL but no fetcher after serialization
- **THEN** Junior SHALL rehydrate a Slack private-file fetcher before runtime consumes the message

#### Scenario: Queue dispatcher receives message kind

- **WHEN** the queue dispatcher receives `new_mention` or `subscribed_message`
- **THEN** it SHALL call the corresponding runtime entrypoint and SHALL NOT decide reply eligibility itself

### Requirement: State adapter key and lock prefixing

Junior SHALL allow storage key prefixing without leaking prefixed lock or queue identifiers to callers.

#### Scenario: State key prefix is configured

- **WHEN** Junior wraps a state adapter with a key prefix
- **THEN** storage operations SHALL use the prefixed physical keys

#### Scenario: Caller acquires a lock

- **WHEN** a caller acquires, extends, or releases a lock through the prefixed adapter
- **THEN** the caller-facing lock thread id SHALL remain the unprefixed logical thread id

#### Scenario: Caller enqueues or dequeues

- **WHEN** a caller uses queue operations through the prefixed adapter
- **THEN** caller-facing queue identifiers and dequeued entries SHALL remain logical and unprefixed

### Requirement: Active lock heartbeat

Junior SHALL keep SDK-sized active turn locks leased during long live handlers while bounding lock lifetime.

#### Scenario: SDK-sized lock is acquired

- **WHEN** a lock is acquired with a TTL at or below the active lock threshold
- **THEN** Junior SHALL acquire it with at least the active lock TTL and start a heartbeat to extend it while the handler remains active

#### Scenario: Lock is released

- **WHEN** a heartbeated lock is released or force-released
- **THEN** Junior SHALL stop the heartbeat for that lock

#### Scenario: Lock heartbeat reaches max age

- **WHEN** a heartbeated lock has been alive longer than the configured active lock max age
- **THEN** Junior SHALL stop extending the lock so another handler can eventually acquire it

#### Scenario: Explicit long TTL lock is acquired

- **WHEN** a caller acquires a lock with an explicit TTL longer than the active lock threshold
- **THEN** Junior SHALL NOT attach the active-turn heartbeat unless the caller later extends it with an SDK-sized TTL

### Requirement: Resume lock coordination

Junior SHALL serialize timeout/auth resume work under the same logical thread lock as live turn execution.

#### Scenario: Resume callback starts

- **WHEN** a timeout or auth resume handler is ready to continue a Slack turn
- **THEN** it SHALL acquire the same logical thread lock before reading or mutating thread/session state

#### Scenario: Resume lock is busy

- **WHEN** the resume handler cannot acquire the lock because a live handler or another resume owns it
- **THEN** Junior SHALL report a lock-busy condition to the caller so the callback can retry or reschedule according to session-resumability rules

#### Scenario: Resume finishes or pauses

- **WHEN** resume handling finishes, fails, or parks on a later pause
- **THEN** Junior SHALL release the lock before running deferred pause/failure side effects that do not require exclusive state mutation

### Requirement: Active continuation follow-up handling

Junior SHALL treat user follow-up to a thread with an awaiting timeout continuation as a retry signal for the existing session rather than a second active turn.

#### Scenario: Active turn has awaiting timeout continuation

- **WHEN** a new user message arrives and visible conversation state points at an active turn with an awaiting timeout-resume request
- **THEN** Junior SHALL reschedule the existing continuation and acknowledge continuation instead of starting a new agent turn

#### Scenario: Active turn has no resumable continuation

- **WHEN** a new user message arrives and the active turn pointer does not resolve to an awaiting continuation request
- **THEN** Junior MAY proceed with normal turn preparation according to turn-handling rules

### Requirement: Queue and locking verification taxonomy

Queue and locking verification SHALL separate pure adapter/dispatcher mechanics from runtime and session-resume wiring.

#### Scenario: Adapter or dispatcher mechanics are verified

- **WHEN** verifying lock heartbeat, prefix behavior, queue dispatch kind routing, or attachment fetcher rehydration
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Runtime queue consumption is verified

- **WHEN** verifying skipped-message propagation, queued message prompt/context inclusion, or active continuation follow-up handling
- **THEN** the primary coverage SHALL be integration tests

#### Scenario: Resume callback behavior is verified

- **WHEN** verifying lock-busy retry/reschedule or stale callback handling
- **THEN** the primary coverage SHALL belong primarily to `agent-session-resumability`, with this capability owning only the shared lock contract
