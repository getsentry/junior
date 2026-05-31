## ADDED Requirements

### Requirement: Generic OAuth flow start

Junior SHALL start generic plugin OAuth only from host-controlled runtime code.

#### Scenario: Provider has no OAuth config

- **WHEN** runtime asks to start OAuth for a provider without OAuth configuration
- **THEN** Junior SHALL return a start failure and SHALL NOT create state

#### Scenario: Client id is missing

- **WHEN** the provider client id env var is missing
- **THEN** Junior SHALL return a start failure and SHALL NOT create state

#### Scenario: Base URL is unavailable

- **WHEN** Junior cannot resolve a public base URL
- **THEN** Junior SHALL return a start failure and SHALL NOT create state

#### Scenario: OAuth start succeeds

- **WHEN** OAuth start succeeds
- **THEN** Junior SHALL create random state, store provider/requester/resume context with a short TTL, build an authorization code URL, and privately deliver that URL to the requester

#### Scenario: Provider defines extra authorize params

- **WHEN** provider OAuth config defines scope or authorize parameters
- **THEN** Junior SHALL include those parameters in the authorization URL

### Requirement: Private authorization link delivery

Junior SHALL deliver authorization links only through private requester-visible Slack surfaces.

#### Scenario: Authorization starts in a channel

- **WHEN** a requester needs authorization in a non-DM Slack channel
- **THEN** Junior SHALL first try an ephemeral message to that requester in that channel/thread

#### Scenario: Authorization starts in a DM

- **WHEN** the target channel is a DM
- **THEN** Junior MAY post the authorization link in that DM because the conversation is already private

#### Scenario: In-context private delivery fails

- **WHEN** in-context private delivery fails
- **THEN** Junior SHALL attempt a direct-message fallback to the requester

#### Scenario: Private delivery fully fails

- **WHEN** Junior cannot deliver the authorization link privately
- **THEN** Junior SHALL fail the auth pause and SHALL NOT post the authorization URL publicly

#### Scenario: Public acknowledgement is posted

- **WHEN** Junior publicly acknowledges an auth pause in a Slack thread
- **THEN** the acknowledgement SHALL be URL-free and SHALL only say that authorization is needed and a private link was sent or reused

### Requirement: Plugin auth pause orchestration

Junior SHALL convert missing or stale plugin credentials into a resumable auth pause.

#### Scenario: Command failure includes explicit auth marker

- **WHEN** a command failure includes `junior-auth-required provider=<provider>`
- **THEN** Junior SHALL prefer that provider if it is registered

#### Scenario: Command failure implies provider credentials were rejected

- **WHEN** a command failure matches a registered provider and known auth-failure text
- **THEN** Junior SHALL start plugin OAuth if the provider supports OAuth and requester context is available

#### Scenario: Authorization flow is disabled

- **WHEN** plugin auth is required but authorization flow mode is disabled
- **THEN** Junior SHALL throw an authorization-flow-disabled error instead of sending a link

#### Scenario: Existing pending link can be reused

- **WHEN** the same requester/provider/kind already has a fresh pending auth link
- **THEN** Junior SHALL reuse that pending auth state instead of sending another private link

#### Scenario: Auth pause is recorded

- **WHEN** plugin OAuth pause is started or reused for a resumable turn
- **THEN** Junior SHALL update pending-auth routing state and append an `authorization_requested` session-log event

#### Scenario: Agent is parked

- **WHEN** plugin auth pause is accepted
- **THEN** Junior SHALL abort the current agent run and park the turn at an auth-resumable boundary

### Requirement: MCP authorization orchestration

Junior SHALL handle MCP authorization challenges as host-controlled runtime interrupts.

#### Scenario: MCP auth provider is created

- **WHEN** a configured MCP provider is used in a requester-bound turn
- **THEN** Junior SHALL create or reuse an MCP auth session containing provider, requester, conversation, session, message, channel, configuration, and artifact context

#### Scenario: MCP authorization challenge occurs

- **WHEN** an MCP client reports authorization is required
- **THEN** Junior SHALL patch the auth session with latest configuration/artifact/tool-channel context before delivering the link

#### Scenario: MCP authorization URL is missing

- **WHEN** the MCP auth session has no authorization URL
- **THEN** Junior SHALL fail the MCP auth pause

#### Scenario: MCP pending link can be reused

- **WHEN** the same requester/provider/kind already has a fresh pending auth link
- **THEN** Junior SHALL reuse pending auth and avoid sending another link

#### Scenario: MCP auth pause is recorded

- **WHEN** MCP auth pause is started or reused
- **THEN** Junior SHALL update pending-auth routing state and append an `authorization_requested` session-log event

#### Scenario: MCP auth flow is disabled

- **WHEN** MCP auth is required but authorization flow mode is disabled
- **THEN** Junior SHALL delete the transient MCP auth session and throw an authorization-flow-disabled error

### Requirement: OAuth callback validation and token storage

Junior SHALL validate callbacks before storing tokens or resuming turns.

#### Scenario: Provider is unknown

- **WHEN** the generic OAuth callback provider is not configured
- **THEN** Junior SHALL return an HTML error response

#### Scenario: Provider returned error

- **WHEN** the callback includes an OAuth error parameter
- **THEN** Junior SHALL delete stored state when state is present and return an HTML error response

#### Scenario: Code or state is missing

- **WHEN** the callback lacks required `code` or `state`
- **THEN** Junior SHALL return an HTML error response and SHALL NOT store tokens

#### Scenario: State is missing or expired

- **WHEN** callback state is not found
- **THEN** Junior SHALL return an HTML expired-link response

#### Scenario: State provider mismatches callback provider

- **WHEN** stored state provider differs from the callback provider
- **THEN** Junior SHALL return an HTML provider-mismatch response

#### Scenario: Token exchange succeeds

- **WHEN** token exchange succeeds and scopes satisfy provider requirements
- **THEN** Junior SHALL store parsed tokens by requester id and provider

#### Scenario: Token exchange fails or response is incomplete

- **WHEN** token exchange fails or provider returns an incomplete token response
- **THEN** Junior SHALL return an HTML failure response and SHALL NOT resume the turn

#### Scenario: Granted scope is insufficient

- **WHEN** granted scope does not satisfy provider requirements
- **THEN** Junior SHALL return an HTML failure response and SHALL NOT store insufficient credentials

### Requirement: MCP callback validation and credential finalization

Junior SHALL finalize MCP OAuth through the MCP SDK-managed auth provider.

#### Scenario: MCP callback state is missing

- **WHEN** MCP callback has no state
- **THEN** Junior SHALL return a missing-state HTML response

#### Scenario: MCP provider returned error

- **WHEN** MCP callback includes an error parameter
- **THEN** Junior SHALL return a provider-error HTML response

#### Scenario: MCP callback code is missing

- **WHEN** MCP callback has no authorization code
- **THEN** Junior SHALL return a missing-code HTML response

#### Scenario: MCP auth session is valid

- **WHEN** MCP callback state identifies a valid auth session for the provider
- **THEN** Junior SHALL call SDK auth finalization, persist SDK-managed credentials, delete the completed auth session, and schedule Slack resume

#### Scenario: MCP finalization fails

- **WHEN** MCP auth finalization fails
- **THEN** Junior SHALL return an HTML failure response and SHALL NOT resume the turn

### Requirement: Authorization session-log events

Junior SHALL represent authorization lifecycle facts in the agent session log.

#### Scenario: Authorization is requested

- **WHEN** plugin or MCP auth pause is started or reused for a session
- **THEN** Junior SHALL append `authorization_requested` with kind, provider, requester id, authorization id, and private-link delivery disposition

#### Scenario: Authorization completes before resume

- **WHEN** generic or MCP callback is about to resume an auth-blocked session
- **THEN** Junior SHALL append `authorization_completed` with kind, provider, requester id, and authorization id before the resumed model run starts

#### Scenario: Pi context is rebuilt for resume

- **WHEN** a turn resumes after authorization completion
- **THEN** Junior SHALL project the session-log completion event as a concise host-authored observation in chronological order

#### Scenario: Prompt context is built

- **WHEN** prompt context is built for a resumed turn
- **THEN** Junior SHALL NOT inject pending-auth or auth-completed facts as prompt-only flags

### Requirement: Pending-auth routing state

Junior SHALL use pending-auth state only for callback routing, deduplication, and stale-resume suppression.

#### Scenario: Pending auth exists for same requester/provider/kind

- **WHEN** a new auth pause requests the same requester/provider/kind while the pending link is fresh
- **THEN** Junior MAY reuse the prior private link state

#### Scenario: Callback targets current pending request

- **WHEN** callback completes and pending-auth state still points to the latest relevant blocked request
- **THEN** Junior MAY resume that request

#### Scenario: Callback is stale

- **WHEN** callback completes after a newer thread message has superseded the blocked request
- **THEN** Junior SHALL store completed credentials when applicable, clear/abandon the stale pending request, and SHALL NOT post a stale resumed answer

#### Scenario: Pending auth is cleared

- **WHEN** a resumed auth turn completes, fails, or is abandoned
- **THEN** Junior SHALL clear pending-auth routing state for that session

### Requirement: Auth callback resume

Junior SHALL resume auth-blocked turns through the same durable Slack resume path as other resumable turns.

#### Scenario: Session record is awaiting auth resume

- **WHEN** callback finds a session record in `awaiting_resume` with resume reason `auth`
- **THEN** Junior SHALL rebuild reply context from persisted conversation, artifacts, configuration, sandbox, attachments, and Pi messages

#### Scenario: Session record is terminal

- **WHEN** callback finds the session record already completed, failed, or abandoned
- **THEN** Junior SHALL NOT re-run the user request

#### Scenario: Resume succeeds

- **WHEN** the resumed reply is delivered and state persists
- **THEN** Junior SHALL persist delivered reply state and complete the session record through normal delivery flow

#### Scenario: Resume fails

- **WHEN** the resumed turn fails
- **THEN** Junior SHALL mark conversation and session state failed through auth-resume failure handling

#### Scenario: Resumed turn pauses again for auth

- **WHEN** a resumed turn hits another auth pause
- **THEN** Junior SHALL persist the new auth pause state and avoid treating the prior callback as final completion

#### Scenario: Resumed turn times out

- **WHEN** a resumed auth turn times out with retryable metadata
- **THEN** Junior SHALL schedule timeout resume if slice limits allow

### Requirement: OAuth-flow verification taxonomy

OAuth-flow verification SHALL separate deterministic state/callback behavior, Slack/runtime wiring, and model-facing resume quality.

#### Scenario: Local OAuth logic is verified

- **WHEN** verifying state parsing, token request parsing, scope checks, private-delivery branching, auth orchestration, MCP auth stores, callback error responses, and stale suppression
- **THEN** the primary coverage SHALL be unit tests

#### Scenario: Slack/runtime resume is verified

- **WHEN** verifying private URL delivery, URL-free public acknowledgement, same-thread resume, state persistence, and file/status behavior
- **THEN** the primary coverage SHALL be integration tests with Slack HTTP mocking

#### Scenario: Model-facing continuation is verified

- **WHEN** verifying resumed answers preserve prior context and continue the original provider request
- **THEN** the primary coverage SHALL be evals owned with `agent-session-resumability`, `agent-turn-handling`, and provider workflow specs
