## ADDED Requirements

### Requirement: Plugin-facing dispatch API

Junior SHALL expose durable agent dispatch only through trusted plugin heartbeat contexts.

#### Scenario: Plugin dispatches agent work

- **WHEN** a trusted plugin calls `ctx.agent.dispatch(options)`
- **THEN** Junior SHALL validate the options, create or reuse a core dispatch record, schedule a core-owned callback when appropriate, and return `{ id, status }`

#### Scenario: Dispatch already exists

- **WHEN** the same plugin dispatches with the same idempotency key
- **THEN** Junior SHALL return the existing dispatch id with status `already_exists`

#### Scenario: Plugin reads owned dispatch

- **WHEN** a plugin calls `ctx.agent.get(id)` for its own dispatch
- **THEN** Junior SHALL return only the plugin-visible projection

#### Scenario: Plugin reads another plugin's dispatch

- **WHEN** a plugin calls `ctx.agent.get(id)` for a dispatch owned by another plugin
- **THEN** Junior SHALL return `undefined`

### Requirement: Dispatch option validation

Junior SHALL reject malformed plugin dispatch options before creating durable records or counting heartbeat fanout.

#### Scenario: Idempotency key is missing or too long

- **WHEN** `idempotencyKey` is blank or exceeds the maximum length
- **THEN** dispatch validation SHALL fail

#### Scenario: Destination platform is unsupported

- **WHEN** `destination.platform` is not `slack`
- **THEN** dispatch validation SHALL fail

#### Scenario: Slack destination ids are invalid

- **WHEN** `teamId` is not a Slack team id or `channelId` is not a Slack conversation id
- **THEN** dispatch validation SHALL fail

#### Scenario: Input is missing or too long

- **WHEN** `input` is blank or exceeds the maximum length
- **THEN** dispatch validation SHALL fail

#### Scenario: Metadata is malformed

- **WHEN** metadata has too many keys, blank keys, non-string values, overlong keys, or overlong values
- **THEN** dispatch validation SHALL fail

### Requirement: Delegated credential subject validation

Junior SHALL allow delegated user credential subjects only for private direct Slack dispatches.

#### Scenario: Credential subject is valid

- **WHEN** `credentialSubject` is `{ type: "user", userId, allowedWhen: "private-direct-conversation" }` and destination channel is a Slack DM
- **THEN** dispatch validation SHALL pass

#### Scenario: Credential subject targets a channel

- **WHEN** `credentialSubject` is present and destination channel is not a Slack DM
- **THEN** dispatch validation SHALL fail

#### Scenario: Credential subject is malformed

- **WHEN** credential subject type, user id, or `allowedWhen` is invalid
- **THEN** dispatch validation SHALL fail

### Requirement: Durable dispatch record creation

Junior SHALL persist dispatch records idempotently and separately from plugin domain state.

#### Scenario: New dispatch is created

- **WHEN** validated dispatch options are created for a plugin/idempotency key pair
- **THEN** Junior SHALL persist a record with deterministic id, plugin, idempotency key, system actor, destination, input, optional credential subject, optional metadata, status `pending`, version, attempts, and timestamps

#### Scenario: Existing dispatch record is present

- **WHEN** a dispatch id already has a record
- **THEN** Junior SHALL return the existing record without overwriting input, destination, metadata, or status

#### Scenario: Dispatch record is incomplete

- **WHEN** a dispatch record is not terminal
- **THEN** Junior SHALL include it in the incomplete-dispatch recovery index

#### Scenario: Dispatch record becomes terminal

- **WHEN** dispatch status becomes `completed`, `failed`, or `blocked`
- **THEN** Junior SHALL remove it from the incomplete-dispatch recovery index

### Requirement: Dispatch projection privacy

Junior SHALL hide raw dispatch state from plugins.

#### Scenario: Projection is returned

- **WHEN** a plugin reads its own dispatch
- **THEN** the projection SHALL include id, status, optional `resultMessageTs`, and optional `errorMessage`

#### Scenario: Hidden fields exist

- **WHEN** the stored record includes input, destination, actor, metadata, credential subject, attempts, leases, or continuation fields
- **THEN** `ctx.agent.get(id)` SHALL omit those fields

### Requirement: Internal callback signing

Junior SHALL schedule and verify core-owned dispatch callbacks with HMAC signing.

#### Scenario: Callback is scheduled

- **WHEN** Junior schedules a dispatch callback
- **THEN** it SHALL POST to `/api/internal/agent-dispatch` with JSON body containing dispatch id and expected version, a timestamp header, and a versioned HMAC signature

#### Scenario: Base URL is missing

- **WHEN** Junior cannot resolve a public base URL
- **THEN** callback scheduling SHALL fail

#### Scenario: Dispatch secret is missing

- **WHEN** `JUNIOR_SECRET` is missing
- **THEN** callback scheduling and verification SHALL fail

#### Scenario: Callback signature is invalid

- **WHEN** callback timestamp, signature, secret, body, or payload shape is missing, stale, malformed, or mismatched
- **THEN** verification SHALL return no payload and the handler SHALL respond `401`

#### Scenario: Callback verifies

- **WHEN** callback verification succeeds
- **THEN** the handler SHALL enqueue one dispatch slice through `waitUntil` and respond `202`

### Requirement: Heartbeat recovery

Junior SHALL re-drive stale incomplete dispatches before invoking trusted plugin heartbeat hooks.

#### Scenario: Pending dispatch is stale

- **WHEN** a pending dispatch has no recent callback attempt
- **THEN** recovery MAY schedule another callback

#### Scenario: Running dispatch lease expired

- **WHEN** a running dispatch has an expired lease
- **THEN** recovery MAY schedule another callback

#### Scenario: Awaiting resume dispatch is stale

- **WHEN** an awaiting-resume dispatch has no active lease or an expired lease
- **THEN** recovery MAY schedule another callback

#### Scenario: Dispatch exceeds max age

- **WHEN** an incomplete dispatch exceeds the maximum dispatch age
- **THEN** Junior SHALL mark it `failed`

#### Scenario: Dispatch exceeds max attempts

- **WHEN** an incomplete stale dispatch has reached max attempts and is not actively leased
- **THEN** Junior SHALL mark it `failed`

#### Scenario: Dispatch is terminal

- **WHEN** recovery sees a terminal dispatch
- **THEN** it SHALL NOT schedule another callback

### Requirement: Dispatch claim and locking

Junior SHALL serialize dispatch execution by dispatch id and destination conversation.

#### Scenario: Callback claims dispatch

- **WHEN** a callback's id and expected version match a non-terminal dispatch that can run
- **THEN** the runner SHALL mark it `running`, set a slice lease, and record callback time under dispatch lock

#### Scenario: Callback is stale

- **WHEN** the dispatch is missing, terminal, already leased, over attempts, or version-mismatched
- **THEN** the runner SHALL do nothing

#### Scenario: Destination conversation is locked

- **WHEN** the destination conversation lock cannot be acquired
- **THEN** the runner SHALL return dispatch to `pending` without burning an attempt

#### Scenario: Runner starts slice

- **WHEN** destination lock is acquired and the record is still current
- **THEN** the runner SHALL increment attempt count before calling the agent

### Requirement: System actor runner context

Junior SHALL run dispatched agent work as a system-authored synthetic Slack conversation turn.

#### Scenario: Dispatch runner calls agent

- **WHEN** a dispatch slice calls `generateAssistantReply`
- **THEN** it SHALL use a stable conversation id derived from Slack team/channel, a stable dispatch turn id, system actor correlation, disabled authorization flow mode, persisted conversation/artifacts/sandbox state, channel configuration, and no Slack requester

#### Scenario: Synthetic user message is created

- **WHEN** a dispatch slice builds conversation context
- **THEN** it SHALL upsert a stable user-role synthetic message id `dispatch:<dispatch.id>:user` with a system author

#### Scenario: Delegated credential subject is present

- **WHEN** a valid dispatch credential subject exists
- **THEN** the runner SHALL pass it as `credentialSubject` without changing the system actor or Slack requester

### Requirement: Slack delivery idempotency

Junior SHALL make visible dispatch delivery best-effort exactly once.

#### Scenario: Assistant message was already persisted as replied

- **WHEN** persisted conversation state contains `dispatch:<dispatch.id>:assistant` with replied Slack timestamp
- **THEN** the runner SHALL mark dispatch `completed` with that timestamp and SHALL NOT post again

#### Scenario: Reply has text

- **WHEN** the agent returns a successful visible reply
- **THEN** the runner SHALL plan Slack posts, post to the destination channel, persist assistant message state with stable id, and mark dispatch `completed`

#### Scenario: Reply has files but no text

- **WHEN** the agent reply contains files but no visible text
- **THEN** the runner SHALL add fallback visible text before delivery

#### Scenario: Agent returns failed diagnostic outcome

- **WHEN** the agent reply diagnostics indicate failure
- **THEN** the runner SHALL finalize a failed-turn reply, deliver it when possible, and mark dispatch `failed`

### Requirement: Dispatch timeout continuation

Junior SHALL continue timed-out dispatch runs through the dispatch callback path, not the interactive Slack resume route.

#### Scenario: Agent slice times out resumably

- **WHEN** the agent throws a timeout-resume retryable error with a resumable version and schedulable next slice
- **THEN** the runner SHALL mark dispatch `awaiting_resume`, persist the resume record version, and schedule a new dispatch callback with the updated record version

#### Scenario: Continuation callback runs

- **WHEN** the next callback claims an awaiting-resume dispatch
- **THEN** it SHALL resume with the same dispatch id, turn id, conversation id, actor, destination, input, and persisted Pi/conversation state

### Requirement: Dispatch authorization blocking

Junior SHALL block dispatched work that requires interactive authorization.

#### Scenario: Authorization flow is requested

- **WHEN** dispatched agent work requires plugin or MCP authorization through an interactive auth flow
- **THEN** the runner SHALL mark the dispatch `blocked` and SHALL NOT start a user authorization link flow

#### Scenario: Plugin credential failure is explicit

- **WHEN** dispatched agent work fails with a plugin credential failure that cannot be repaired in system context
- **THEN** the runner SHALL mark the dispatch `blocked` with an error message

### Requirement: Dispatch limits

Junior SHALL bound dispatch fanout and recovery work.

#### Scenario: Heartbeat exceeds dispatch fanout

- **WHEN** one heartbeat context creates more than the maximum allowed dispatches
- **THEN** further dispatch calls SHALL fail

#### Scenario: Invalid dispatch requests occur

- **WHEN** dispatch validation fails
- **THEN** the invalid request SHALL NOT count against heartbeat dispatch fanout

#### Scenario: Recovery limit is reached

- **WHEN** recovery has scheduled the configured maximum number of stale dispatches
- **THEN** it SHALL stop recovery for that heartbeat pass

### Requirement: Dispatch verification taxonomy

Junior SHALL verify dispatch behavior at deterministic core boundaries.

#### Scenario: Validation or signing changes

- **WHEN** option validation, callback signing, or callback parsing changes
- **THEN** unit tests SHALL cover the changed behavior

#### Scenario: Store or recovery behavior changes

- **WHEN** idempotency, projection, terminal index cleanup, retry bounds, or recovery changes
- **THEN** integration tests or state-helper unit tests SHALL cover the changed behavior

#### Scenario: Runner behavior changes

- **WHEN** system actor context, locks, delivery, continuation, authorization blocking, or state persistence changes
- **THEN** integration tests SHALL cover the changed behavior

#### Scenario: Scheduler-visible behavior changes

- **WHEN** scheduler task/run reconciliation depends on dispatch state
- **THEN** scheduler integration tests SHALL cover the plugin-visible result
