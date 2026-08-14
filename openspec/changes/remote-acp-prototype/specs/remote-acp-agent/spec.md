# Remote ACP Agent

## ADDED Requirements

### Requirement: Remote ACP Is Opt-In And HTTP Only

Junior SHALL expose the prototype only as an experimental ACP v1 Streamable
HTTP endpoint.

#### Scenario: Feature is disabled

- **WHEN** `createApp()` does not enable `experimental.acp`
- **THEN** `/api/acp` is not registered
- **AND** Junior does not start an ACP transport.

#### Scenario: Feature is enabled

- **WHEN** `createApp()` enables `experimental.acp`
- **THEN** Junior registers `GET`, `POST`, and `DELETE` at `/api/acp`
- **AND** it forwards those requests through the official ACP Streamable HTTP
  server
- **AND** it does not register an ACP WebSocket upgrade or stdio command.

### Requirement: Every ACP Request Is Authenticated

Junior SHALL authenticate every ACP HTTP request with an active personal bearer
token before protocol dispatch.

#### Scenario: Bearer token is absent or invalid

- **WHEN** an ACP request has no active `jr_pat_...` bearer token
- **THEN** Junior returns `401`
- **AND** it does not create or access ACP connection or session state.

#### Scenario: Bearer token is valid

- **WHEN** an ACP request has an active personal token
- **THEN** Junior resolves its owner to the canonical User and web Actor
- **AND** the ACP Agent for a new connection runs with that Actor.

#### Scenario: Another Actor reuses a connection id

- **WHEN** a valid token for one Actor sends an ACP connection id bound to a
  different Actor
- **THEN** Junior rejects the request before ACP dispatch
- **AND** it does not expose whether that connection has an active session.

### Requirement: ACP Sessions Are Private Conversations

Junior SHALL use one private Conversation as the durable state for each ACP
session.

#### Scenario: Client creates a session

- **WHEN** an authenticated client calls `session/new`
- **THEN** Junior creates an empty private root Conversation owned by the Actor
- **AND** the Conversation uses the existing web Source and a local Destination
- **AND** Junior returns the Conversation id as the ACP `sessionId`.

#### Scenario: Client supplies workspace paths

- **WHEN** a client creates or loads a session with `cwd` or additional
  directories
- **THEN** Junior does not treat those paths as host or sandbox access
- **AND** Junior does not persist or inject those paths into the Turn.

#### Scenario: Client supplies MCP servers

- **WHEN** a client creates or loads a session with one or more MCP server
  configurations
- **THEN** Junior rejects the request as unsupported
- **AND** Junior does not start or connect to those MCP servers.

#### Scenario: Another Actor uses a session id

- **WHEN** an Actor calls `session/load` or `session/prompt` with another
  Actor's private Conversation id
- **THEN** Junior rejects the operation
- **AND** it does not expose Conversation content.

### Requirement: Text Prompts Use The Durable Turn Runtime

Junior SHALL execute supported ACP prompts through the existing API Turn
mailbox and shared worker.

#### Scenario: Client sends a text prompt

- **WHEN** an authorized client sends one or more non-empty text prompt blocks
- **THEN** Junior joins them in order
- **AND** appends one deferred mailbox Message to the session Conversation
- **AND** runs it as a web Source with `publishExternally: false`
- **AND** Junior's existing sandbox, tools, plugins, and credential boundaries
  remain in effect.

#### Scenario: Client sends an unsupported prompt block

- **WHEN** a prompt is empty or contains a non-text content block
- **THEN** Junior rejects it as invalid protocol input
- **AND** it does not append a mailbox Message.

#### Scenario: Client retries a prompt request

- **WHEN** the same ACP JSON-RPC request id is handled again on the same
  connection
- **THEN** Junior derives the same mailbox idempotency key
- **AND** the Conversation contains at most one inbound Message for that
  request.

### Requirement: Prompt Output Follows Durable Conversation Events

Junior SHALL derive ACP prompt output from the matching durable Turn and its
visible Messages.

#### Scenario: Turn writes an assistant Message

- **WHEN** the matching Turn stores a visible assistant Message
- **THEN** Junior sends its text as one ACP `agent_message_chunk` update
- **AND** it awaits updates in increasing Conversation event sequence.

#### Scenario: Turn completes

- **WHEN** the matching Turn completes successfully or with no reply
- **THEN** Junior resolves `session/prompt` with `stopReason: "end_turn"`.

#### Scenario: Turn fails

- **WHEN** the matching Turn stores a terminal failure
- **THEN** Junior resolves the ACP request with a JSON-RPC error
- **AND** it does not report a successful stop reason.

#### Scenario: ACP connection closes during a Turn

- **WHEN** the ACP request signal ends before the durable Turn completes
- **THEN** Junior stops waiting on that connection
- **AND** the durable Turn continues under the existing worker contract
- **AND** its later visible result remains available through `session/load`.

### Requirement: A New Connection Can Load A Session

Junior SHALL advertise load support and rebuild visible ACP history from the
authorized Conversation.

#### Scenario: Owner loads an existing session

- **WHEN** the owning Actor initializes a new connection and calls
  `session/load` with a saved session id
- **THEN** Junior replays visible user and assistant Messages in event order
- **AND** user text uses `user_message_chunk`
- **AND** assistant text uses `agent_message_chunk`
- **AND** internal agent history and system Messages are not replayed.

#### Scenario: Loaded session receives another prompt

- **WHEN** replay finishes and the client sends another text prompt
- **THEN** Junior appends it to the same Conversation
- **AND** executes it through the normal API Turn mailbox path.

### Requirement: Prototype Limits Are Explicit

Junior SHALL describe the ACP endpoint as a single-process happy-path
experiment, not as complete ACP support.

#### Scenario: Prototype capabilities are initialized

- **WHEN** Junior answers `initialize`
- **THEN** it advertises `loadSession`
- **AND** image, audio, and embedded-context prompt capabilities are false
- **AND** it does not advertise filesystem, terminal, mode, model, or session
  management capabilities.

#### Scenario: User follows the smoke instructions

- **WHEN** a user tests the prototype
- **THEN** the instructions use one local Node process and the existing
  Cloudflare tunnel
- **AND** they state that active Turn cancellation and multi-process transport
  state are not supported
- **AND** they state that resource-link and other non-text prompts are not
  supported
- **AND** they do not require a stdio agent, registry entry, or local bridge.
