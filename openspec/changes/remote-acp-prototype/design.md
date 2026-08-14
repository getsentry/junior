# Remote ACP Prototype Design

## Context

Junior already has the durable parts of a hosted agent. A Conversation stores
visible history and execution state. The API Turn path writes a web Source to
the mailbox, runs the shared worker, and keeps output in the Conversation with
`publishExternally: false`.

ACP adds a client-facing session protocol. The v1 Streamable HTTP transport in
`@agentclientprotocol/sdk` accepts `GET`, `POST`, and `DELETE` requests and
returns Web `Response` objects. Hono can pass its raw `Request` to that server.

The current T3 Code generic ACP proposal
([pingdotgg/t3code#6071](https://github.com/pingdotgg/t3code/pull/6071))
and Zed's public agent setup start ACP agents over stdio. They are not remote
acceptance targets today. Both use standard ACP session methods. Junior should
therefore expose the standard remote protocol and avoid a client-specific
adapter or launch command.

The SDK has one important deployment limit. `Acp-Connection-Id` refers to state
in a process-local map. A client must keep all requests for one connection on
the same process. The draft distributed backend work in
[agentclientprotocol/typescript-sdk#198](https://github.com/agentclientprotocol/typescript-sdk/pull/198)
does not provide a released distributed store. This prototype will run in one
local Node process through the existing Cloudflare tunnel.

## Existing Owners To Reuse

ACP is a new wire adapter, not a new Junior runtime. The implementation must
reuse these current owners:

- `personal-tokens/store.ts` validates personal tokens.
- `plugins/viewer.ts` resolves the canonical User.
- `api-turns/work.ts` builds the web Actor, records web Conversation activity,
  appends mailbox Messages, sets `publishExternally: false`, and derives the
  Turn id.
- `api/conversations/access.ts` decides whether a User is a Conversation
  participant and can view private content.
- `ConversationEventStore.query()` already reads bounded forward event pages by
  `seq`.
- `chat/sleep.ts` already supplies an abort-aware wait for a small polling loop.
- `loadMessageHistory()` and `projectConversationMessages()` already rebuild
  visible Messages in canonical order.
- The API Turn integration fixture already wires the real queue, worker,
  Conversation store, and fake model edge.

The ACP module owns only HTTP transport state, protocol validation, conversion
between ACP requests and these functions, and conversion of their durable
results to ACP updates. It must not add a second mailbox, execution path,
Conversation access rule, event schema, or replay reducer.

## Goals

- Let an official ACP HTTP client connect to hosted-style Junior through a URL
  and personal token.
- Support the smallest useful session path: initialize, new, text prompt,
  assistant update, Turn completion, load, replay, and another prompt.
- Keep the Conversation, mailbox, worker, sandbox, tools, and credentials as
  Junior-owned runtime boundaries.
- Keep all ACP connection state inside one `createApp()` instance.
- Produce enough evidence to decide whether to promote the endpoint.

## Non-Goals

- A `junior acp` command, stdio transport, local agent registry, or local launch
  configuration.
- A bridge to client filesystem, terminal, or MCP servers. A thin bridge may be
  added later only as test equipment.
- WebSocket transport or experimental ACP v2 behavior.
- Production support for multiple web processes or process restarts.
- Active Turn cancellation. The current cancellation path only removes queued
  Messages and cannot stop a running Turn.
- Token-level output, reasoning, tool status, permission requests, resource
  links, media prompts, modes, models, session listing, session deletion, or
  session resume.
- Junior-to-Junior delegation from issue #530.

## Decisions

### Use one opt-in core HTTP route

Add `acp` to the known experimental feature keys. When
`createApp({ experimental: { acp: true } })` is used, mount `/api/acp` for
`GET`, `POST`, and `DELETE`. When the feature is off, the route does not exist.

Construct one ACP server and its connection ownership map inside `createApp()`.
Pass that state to an `api/acp` route module. Do not add a mutable module global.
The route forwards the raw Hono `Request` to the ACP SDK and returns the SDK
`Response` without translating JSON-RPC or Server-Sent Events.

Use ACP v1 Streamable HTTP only. Do not register a WebSocket upgrade or add a
stdio entry point.

### Authenticate HTTP before ACP dispatch

Require `Authorization: Bearer jr_pat_...` on every ACP request. Use
`authenticatePersonalToken()`, `resolveViewerUser()`, and `webActorFromEmail()`.
Return `401` before ACP dispatch when the token is absent, invalid, expired, or
revoked.

Do not widen personal-token write access in the dashboard middleware. The ACP
route owns its mutation authority. Do not advertise an ACP authentication
method or implement `authenticate`; the HTTP bearer token is the authentication
boundary.

The SDK can receive an Agent override when it creates a connection. Build that
Agent with the authenticated Actor and a random connection nonce. After a
successful initialize response, bind its `Acp-Connection-Id` to the Actor in an
app-scoped map. A later request with that connection id must use a token for the
same Actor. Remove the binding on `DELETE`.

This check protects the transport connection. Each session operation must also
authorize its Conversation. A valid token must never load or prompt another
Actor's private Conversation.

### Use the Conversation id as the ACP session id

`session/new` creates an empty private root Conversation with an id such as
`local:acp:<uuid>`. Return that Conversation id as the ACP `sessionId`. This
avoids a second session table and keeps reconnect data durable.

Use the existing web Source, local Destination, and web Actor. Do not add an
ACP branch to the shared Source union for the prototype. Export or refactor the
existing API Turn activity function so `session/new` and prompt append use the
same root materialization path. Do not add a second Conversation creation path.

The client `cwd` and additional directories do not select Junior's execution
filesystem. Junior continues to use its own sandbox. Accept those values as
client context, but do not persist them or grant access to them. Reject a new or
loaded session with non-empty client MCP server configuration. Silent MCP
acceptance would imply that Junior will run those servers.

### Advertise only the implemented protocol surface

`initialize` reports the supported ACP v1 protocol version and
`loadSession: true`. It does not advertise filesystem, terminal, mode, model,
session management, or other optional capabilities.

Register handlers for `initialize`, `session/new`, `session/load`, and
`session/prompt`. Accept text prompt blocks only. Join multiple text blocks in
their original order. Reject a prompt that is empty or contains another content
type.

ACP v1 treats resource links as baseline prompt input, but a remote Junior
cannot resolve client-local links safely. The text-only slice is therefore
another stated conformance gap. Do not fetch or silently flatten resource links
in this prototype.

Do not register `session/cancel` in this prototype. A client disconnect stops
the ACP waiter, but it does not stop the durable Junior Turn. The Conversation
can be loaded later to see the result. This is a known ACP conformance gap and
a required promotion gate. Do not implement a no-op and describe it as
cancellation support.

### Reuse the API Turn mailbox

Before enqueue, read the latest Conversation event sequence. Call
`appendAndEnqueueApiConversationMessage()` with the authenticated web Actor,
the ACP session id, and the text prompt. That function already creates a
deferred mailbox delivery and sets `publishExternally: false`.

Build the mailbox idempotency key from the random connection nonce and the ACP
JSON-RPC request id. Use the accepted Message id with
`apiTurnIdForMessage()` to identify the matching Turn. This keeps a retried ACP
request from creating a second mailbox Message.

After enqueue, query the canonical Conversation event store forward from the
saved sequence. Use bounded pages, increasing `seq`, and the existing
abort-aware `sleep()` between empty reads. Do not add a new event bus or wait
utility. For the matching Turn:

- send each durable assistant Message as one ACP `agent_message_chunk` update;
- return `stopReason: "end_turn"` after matching successful or no-reply Turn
  completion;
- return a JSON-RPC error after matching Turn failure; and
- stop only the HTTP waiter when its connection signal is aborted.

Assistant updates are Message-level in this prototype. They are not model-token
streaming. Await each ACP notification so update order matches Conversation
event order.

### Load by authorizing and replaying visible Messages

`session/load` resolves the session id as a Conversation id. Require the
authenticated User to pass `readConversationAccessFromSql()` before reading
private content. Return a protocol error for an absent or unauthorized
Conversation without exposing its contents.

Use `loadMessageHistory()` and `projectConversationMessages()` to read canonical
visible Message history in event order. Replay user Messages as
`user_message_chunk` updates and assistant Messages as `agent_message_chunk`
updates. Skip system Messages and internal agent history. Do not add an ACP-only
history reducer. After replay, the client can send another prompt through the
normal mailbox path.

ACP v1 reconnect creates a new transport connection. The client must initialize
that connection and then call `session/load` with the saved session id. The
prototype does not replay updates that were only in an old transport stream;
it rebuilds the visible state from the Conversation.

### Validate through one process and a real HTTP client

Add one protocol integration scenario through the real Hono app, ACP HTTP
transport, mailbox, worker, Conversation store, and event projection. Fake only
the model stream. Extend the existing API Turn integration fixture instead of
creating a second worker harness.

Add a small smoke client that uses the official ACP HTTP client. It reads the
endpoint and personal token from environment variables. It is test equipment,
not a bridge or a product transport. Use it against `pnpm dev` through the
existing Cloudflare tunnel.

Add `pnpm acp:local` for repeatable loopback validation. It starts the local
Postgres and Redis services and serves the real app route over TCP. Reuse the
API Turn test harness for the in-process queue and deterministic model output.
Do not add a local ACP protocol or a product queue fallback.

An optional Vercel run may record whether requests keep process affinity. Do
not add Redis, a custom SDK backend, cookies, retries, or WebSocket as part of
this prototype.

## Risks / Trade-offs

- **Process affinity:** A connection fails when its requests reach different
  processes. The prototype supports one process and states this limit.
- **No active cancellation:** Closing a client does not stop model or tool work.
  Full cancellation is required before promotion.
- **Text-only input:** ACP baseline resource links are not supported. Add them
  only after the target client's link meaning and Junior's access boundary are
  clear.
- **Event polling:** Each active prompt reads small forward event pages. Bound
  page size and stop after the matching Turn ends. A later change can add a
  shared notification path if measured load requires it.
- **Connection ownership state:** An unclosed connection leaves one small map
  entry until process exit. Do not add cleanup machinery before this matters in
  the experiment.
- **Client workspace expectations:** Client paths do not refer to Junior's
  sandbox. The smoke instructions must state this clearly.
- **No current editor acceptance client:** The official SDK proves the wire
  contract now. T3 Code or Zed remote support remains a promotion test when one
  of them accepts an ACP URL and bearer token.

## Promotion Gates

Do not call the endpoint production ACP support until all of these are true:

1. A target client such as T3 Code or Zed connects directly by URL and completes
   the tested session path.
2. `session/cancel` stops queued and active work and resolves the prompt with
   `stopReason: "cancelled"`.
3. The deployment has proven connection affinity or uses a released
   distributed ACP HTTP backend.
4. Reconnect behavior is tested across the chosen deployment lifecycle.
5. Required resource-link, tool-status, and permission behavior is agreed with
   the target client.
