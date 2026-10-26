# Credentials And OAuth

This module resolves credential subjects, stores user grants, and brokers
provider authorization without exposing long-lived secrets to the model or
sandbox.

## Authority

- Set the run `actor` first, then project credentials with
  `credentialContextForActor(actor, subject?)`. Do not hand-build parallel
  actor/credential shapes.
- The current actor is the default credential subject.
- A different subject requires explicit delegation carried through the durable
  execution context (system actor + `credentialContext.subject`).
- Runtime binds Slack DM delegation to the exact destination and scheduler
  delegation to the exact scheduler plugin and task id before persistence.
- A scheduled run with a delegated creator subject remains system-acted and
  cannot start an interactive OAuth flow.
- A timer Watch set in a user Turn binds that user to the exact Conversation
  and Watch id. The timer Turn stays system-acted and uses the subject only
  when every batched event carries a valid binding for the same user. A
  resumed timer Turn reads the subject from its Turn record and verifies it
  again.
- Run attribution and conversation membership do not grant provider authority.
- Missing actor or subject context fails closed.

## Issuance

- Provider plugins declare grants, domains, and header transformations.
- Credentials are issued lazily for a verified operation and sandbox context.
- Cache keys include provider, grant, subject, operation/resource scope,
  sandbox session, and expiry as applicable.
- Real credentials remain in host storage and host-applied request headers.

## Service Accounts

A plugin can declare an optional install-wide provider account, often a bot.
The model is the same for every provider:

1. Per-Actor OAuth is the default. An Actor's own connection always wins.
2. An Admin can connect one service account per plugin from the dashboard
   Admin page. The `junior service-account connect <plugin>` CLI is a
   fallback. Until then, it has no effect.
3. The service account serves an Actor without their own connection, but
   only for requests that the plugin's `service-account` policy allows.
   Other requests still ask the Actor to connect.
4. A plugin can set `user-oauth: false`. Then Junior uses only the service account.
   It ignores Actor connections and never asks an Actor to connect. The
   policy must cover everything the plugin exposes. Until an Admin connects
   the account, the plugin is not available.

- `service-account.ts` owns the policy check, `serviceAccountAllows`. A
  surface must ask it before it uses the shared account.
- `serviceAccountOnly` reports `user-oauth: false`. A surface must check it before
  it falls back to Actor auth or asks an Actor to connect.
- Each surface enforces the policy where it sees the request. MCP calls run
  on the host, so the tool manager checks each tool against `mcp-tools`.
- A new surface adds one policy key and one request kind to
  `serviceAccountAllows`. Sandbox egress should use the grant `access` that
  it already selects for each request, so the proxy never signs a write with
  a read-only account.
- The service account usually has fewer provider permissions than a person.
  Everyone who can talk to Junior can use what the policy allows, so the
  provider account should see only what all of them may see.
- Unknown policy keys fail manifest validation. A key that no surface
  enforces must not be accepted.
- `service-account.ts` also owns the connect flow. The dashboard routes in
  `api/service-accounts/` and the CLI both call it. Whoever signs in picks
  the account that everyone falls back to, so every dashboard route,
  including the OAuth callback, requires an Admin. A pending sign-in is
  single-use, expires after 10 minutes, and finishes only for the Admin who
  started it.

## OAuth Flow

1. A provider reports that a user-bound grant is required.
2. Runtime stores a short-lived, single-use authorization request bound to the
   actor, provider, conversation, and requested continuation.
3. The authorization URL is delivered privately; public conversation output
   contains no reusable URL or token.
4. The callback validates state, exchanges and stores the token, marks the
   request consumed, and appends work to resume the conversation.
5. Replayed, expired, mismatched, or already-consumed callbacks fail without
   altering conversation authority.

### Dashboard Connections

- The dashboard connects and disconnects plugin OAuth accounts through
  `/api/connections`. The credential subject is the viewer's web actor id
  (`webActorFromEmail`), which is the subject of the viewer's web
  Conversations. Slack grants stay keyed by Slack user id and are managed from
  Slack App Home or the slash command.
- A dashboard connection has no Conversation to resume. The callback stores the
  token, links the provider identity to the viewer's user, and does not publish
  Slack App Home. Disconnect removes that provider identity. See
  `../identities/README.md`.
- MCP plugins are not listed yet. Their authorization attempts are bound to a
  Conversation.

### MCP Authorization Attempts

- Every authorization start creates a fresh v2 attempt id. Its PKCE verifier
  and authorization URL are persisted independently and remain write-once.
- Thread-local MCP pending auth includes the exact attempt id before the private
  link is delivered. Failed delivery deletes the new attempt and restores the
  prior pending authorization without abandoning its blocked turn.
- Before each shared user/provider credential mutation, the callback acquires
  the thread lock and verifies that the attempt still owns pending auth.
- Pre-v2 attempts and legacy MCP pending-auth records without an attempt id are
  invalid after the cutover. Existing completed credentials remain valid.

Follow `../../../../../policies/security.md` and
`../../../../../policies/context-bound-systems.md`.
