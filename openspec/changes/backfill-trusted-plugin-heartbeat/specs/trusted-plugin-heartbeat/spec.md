## ADDED Requirements

### Requirement: Trusted heartbeat availability

Junior SHALL expose heartbeat hooks only to trusted app plugins registered by host application code.

#### Scenario: Trusted plugin declares heartbeat

- **WHEN** a `JuniorPlugin` passed through app configuration declares `hooks.heartbeat`
- **THEN** Junior MAY invoke that hook from the core heartbeat runner

#### Scenario: Manifest-only plugin declares data

- **WHEN** a plugin is loaded only from `plugin.yaml`
- **THEN** it SHALL NOT register heartbeat handlers, internal routes, or agent dispatch behavior

#### Scenario: Trusted plugin identity is invalid

- **WHEN** trusted plugin identity validation fails
- **THEN** heartbeat registration SHALL NOT mutate the active trusted plugin set

### Requirement: Core heartbeat endpoint authentication

Junior SHALL own a single internal heartbeat endpoint authenticated by a configured bearer secret.

#### Scenario: Heartbeat request is missing auth

- **WHEN** `/api/internal/heartbeat` receives no valid bearer token
- **THEN** it SHALL return `401` and SHALL NOT schedule heartbeat work

#### Scenario: Heartbeat secret is unavailable

- **WHEN** no heartbeat secret is configured
- **THEN** heartbeat request verification SHALL fail

#### Scenario: Heartbeat request is authenticated

- **WHEN** the bearer token matches the configured heartbeat secret using timing-safe comparison
- **THEN** the handler SHALL schedule heartbeat work with `waitUntil` and return `202`

### Requirement: Heartbeat execution ordering

Junior SHALL run core dispatch recovery before trusted plugin heartbeat handlers on each heartbeat pulse.

#### Scenario: Heartbeat runs

- **WHEN** core heartbeat work starts
- **THEN** Junior SHALL first attempt bounded stale dispatch recovery and then invoke trusted plugin heartbeat hooks

#### Scenario: Dispatch recovery fails for one record

- **WHEN** recovery for one stale dispatch throws
- **THEN** Junior SHALL log the failure and continue processing the bounded recovery pass

### Requirement: Bounded plugin heartbeat invocation

Junior SHALL invoke trusted plugin heartbeat hooks as bounded best-effort work.

#### Scenario: Plugin has no heartbeat hook

- **WHEN** a trusted plugin has no heartbeat hook
- **THEN** Junior SHALL skip it

#### Scenario: Plugin heartbeat hook runs

- **WHEN** a trusted plugin heartbeat hook runs
- **THEN** Junior SHALL provide a heartbeat context containing `nowMs`, plugin metadata, plugin logger, namespaced state, and agent dispatch/get capabilities

#### Scenario: Plugin limit is reached

- **WHEN** the heartbeat runner has invoked the maximum number of plugin hooks for a pass
- **THEN** it SHALL stop invoking more plugin hooks until a later heartbeat

#### Scenario: Plugin hook exceeds time budget

- **WHEN** a plugin heartbeat hook exceeds its time budget
- **THEN** Junior SHALL fail that hook invocation and continue isolating the failure from other plugins

#### Scenario: Plugin hook throws

- **WHEN** a plugin heartbeat hook throws
- **THEN** Junior SHALL log safe plugin metadata and continue with other plugins

#### Scenario: Plugin reports dispatch count

- **WHEN** a heartbeat hook returns a positive dispatch count
- **THEN** Junior MAY log that count with the plugin name

### Requirement: Heartbeat reliability model

Junior SHALL treat heartbeat as an idempotent pulse rather than exact scheduled execution.

#### Scenario: Heartbeat is missed or late

- **WHEN** a heartbeat pulse is missed or arrives late
- **THEN** correctness SHALL depend on plugin durable state and later heartbeats, not process memory

#### Scenario: Heartbeats overlap

- **WHEN** more than one heartbeat invocation runs concurrently
- **THEN** trusted plugins SHALL use namespaced state locks/idempotency and dispatch idempotency to avoid duplicate domain work

#### Scenario: Work remains unfinished

- **WHEN** plugin work exceeds one heartbeat's budget
- **THEN** unfinished work SHALL remain claimable from durable plugin state on later heartbeats

### Requirement: Namespaced plugin state

Junior SHALL expose durable plugin state through a plugin-scoped facade.

#### Scenario: Plugin state key is valid

- **WHEN** a plugin reads, writes, deletes, or locks a valid state key
- **THEN** Junior SHALL map that key into a namespace derived from the plugin name and key

#### Scenario: Plugin state key is invalid

- **WHEN** a plugin state key is blank or exceeds the maximum length
- **THEN** the state operation SHALL fail

#### Scenario: Two plugins use related key strings

- **WHEN** two plugins use the same or delimiter-containing state keys
- **THEN** their state values SHALL remain isolated

#### Scenario: Legacy state prefix is configured

- **WHEN** a trusted plugin declares allowed legacy state prefixes
- **THEN** plugin state MAY read/delete/lock matching legacy keys during migration without granting arbitrary state access

### Requirement: Heartbeat context capability boundaries

Junior SHALL expose only narrow capabilities to heartbeat hooks.

#### Scenario: Heartbeat context is created

- **WHEN** Junior creates a heartbeat context
- **THEN** it SHALL NOT expose raw Slack tokens, Slack Web API clients, raw internal `Request`, route registration, `waitUntil`, raw Redis/state adapter clients, unrestricted agent runtime functions, or provider secrets

#### Scenario: Plugin needs agent work

- **WHEN** a heartbeat plugin needs Junior to run autonomous agent work
- **THEN** it SHALL use `ctx.agent.dispatch` and `ctx.agent.get`, whose detailed semantics are owned by trusted plugin dispatch

#### Scenario: Plugin needs logging

- **WHEN** a heartbeat plugin logs through `ctx.log`
- **THEN** Junior SHALL attach the trusted plugin name and route the event through host logging

### Requirement: Trusted tool registration boundary

Junior SHALL keep trusted plugin tool registration separate from heartbeat route ownership.

#### Scenario: Trusted plugin registers tools

- **WHEN** a trusted plugin exposes a `tools` hook
- **THEN** those tools SHALL be collected during turn tool registration, not from the heartbeat endpoint

#### Scenario: Tool hook needs turn context

- **WHEN** Junior calls a trusted plugin tools hook
- **THEN** it SHALL provide only the narrow current-turn context and plugin state needed to decide tool availability

#### Scenario: Tool policy is model-facing

- **WHEN** a trusted plugin tool needs domain policy
- **THEN** the policy SHALL live in the tool description, schema descriptions, prompt snippet, prompt guidelines, or skill content rather than core heartbeat prompt text

### Requirement: Heartbeat verification taxonomy

Junior SHALL verify heartbeat behavior through endpoint, context, and plugin integration tests.

#### Scenario: Endpoint auth changes

- **WHEN** heartbeat authentication or waitUntil scheduling changes
- **THEN** integration or handler tests SHALL cover authorized and unauthorized requests

#### Scenario: Plugin context changes

- **WHEN** heartbeat context, namespaced state, logger, or dispatch fanout changes
- **THEN** integration tests SHALL cover plugin-visible behavior

#### Scenario: Plugin registration changes

- **WHEN** trusted plugin identity validation changes
- **THEN** unit tests SHALL cover valid and invalid plugin registration

#### Scenario: Scheduler heartbeat behavior changes

- **WHEN** scheduler plugin heartbeat behavior changes
- **THEN** scheduler integration tests SHALL cover due-run claim, dispatch creation, reconciliation, and failure isolation
