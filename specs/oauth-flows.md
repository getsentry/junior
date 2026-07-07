# OAuth Flows Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-06-12

## Related

- [Security Policy](./security-policy.md)
- [Credential Injection Spec](./credential-injection.md)

## Purpose

Define how Junior handles per-user OAuth for third-party providers while keeping authorization links and token values out of model-visible context.

## Architecture

### Components

| Component                            | Role                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startOAuthFlow(provider, ...)`      | Internal runtime helper that creates state and privately delivers the authorization link                                                                                  |
| `/api/oauth/callback/[provider]`     | Exchanges code for tokens, stores them server-side, and resumes the latest still-relevant blocked thread request                                                          |
| `/api/oauth/callback/mcp/[provider]` | Completes MCP SDK authorization and resumes the latest still-relevant MCP-blocked thread request                                                                          |
| `StateAdapterTokenStore`             | Persistent per-user token storage                                                                                                                                         |
| MCP auth session store               | Stores MCP auth session context and SDK-managed OAuth state across the browser redirect                                                                                   |
| `OAuthBearerBroker`                  | Issues short-lived run-scoped leases from stored user tokens                                                                                                              |
| Thread `pendingAuth` state           | Stores the current auth-blocked request for one Slack thread independently from `activeTurnId`                                                                            |
| `PluginAuthOrchestration`            | Consumes structured egress credential signals, starts OAuth privately for OAuth-backed `auth_required` signals, and parks the current agent run as a resumable auth block |

### Why authorization code grant

Junior runs as a Hono service with public HTTPS routes, so Authorization Code Grant (RFC 6749 §4.1) is the correct server-side flow:

- Standard click-to-authorize UX
- No model-side polling loop
- Token values never appear in conversation context
- Code exchange happens server-side with the client secret

## Flow

### Implicit provider authorization

```
User: asks Junior to do authenticated provider work in Slack
  │
  ▼
Agent: loads the matching plugin skill and runs the real provider command
  │
  ├─ Runtime resolves provider from the proxied sandbox request host
  ├─ Runtime keeps any provider defaults (for example a repo config) available for command construction
  ├─ Broker checks stored user OAuth tokens
  ├─ If auth is missing or stale and the egress signal carries OAuth authorization metadata:
  │    • runtime creates OAuth state
  │    • runtime privately delivers the authorization link
  │    • runtime posts a brief visible thread note that authorization is needed
  │    • runtime appends `authorization_requested` to the agent session log
  │    • runtime writes the historical turn-session record as awaiting auth resume
  │    • runtime records thread-local `pendingAuth`
  ├─ If credential setup is unavailable or no OAuth authorization metadata is present:
  │    • runtime surfaces the host-provided credential failure message
  │    • runtime does not start a user OAuth flow
  ├─ If the actor is a Slack bot or other non-human actor:
  │    • runtime surfaces a terminal authorization failure
  │    • runtime does not create pending auth or deliver private auth links
  └─ OAuth-paused runs end cleanly; they are not kept as the active in-flight run
  │
  ▼
User: opens private link and approves
  │
  ▼
Provider: redirects to /api/oauth/callback/<provider>?code=...&state=...
  │
  ├─ Callback validates state and provider match
  ├─ Callback exchanges code for tokens
  ├─ Callback stores tokens by actor ID + provider
  ├─ Callback appends `authorization_completed` to the agent session log
  ├─ Callback refreshes App Home connected-account state (best effort)
  └─ Callback resumes only if the blocked request is still the latest relevant thread request; otherwise it stores tokens and stays silent in Slack
  │
  ▼
User: sees the original request continue in-thread
```

### MCP challenge-driven authorization

```
User: invokes a skill that exposes MCP-backed tools
  │
  ▼
Agent: calls an MCP tool from the same plugin
  │
  ├─ MCP server responds with 401 / auth challenge
  ├─ MCP OAuth provider persists auth session state
  ├─ Runtime privately delivers the authorization link to the requesting user
  ├─ Runtime posts a brief visible thread note that authorization is needed
  ├─ Runtime appends `authorization_requested` to the agent session log
  ├─ Historical turn-session record is written as awaiting auth resume
  ├─ Runtime records thread-local `pendingAuth`
  ├─ Bot or non-human Slack actors fail terminally without pending auth or links
  └─ Current run ends cleanly; it is not kept as the active in-flight run
  │
  ▼
User: opens the private link and approves
  │
  ▼
Provider: redirects to /api/oauth/callback/mcp/<provider>?code=...&state=...
  │
  ├─ Callback loads MCP auth session by state
  ├─ SDK completes OAuth and persists tokens
  ├─ Callback appends `authorization_completed` to the agent session log
  └─ Callback resumes only if the thread's current `pendingAuth` target is still the latest relevant request
```

## Credential issuance

After a user has connected their account:

1. Agent runs an authenticated provider command.
2. Runtime resolves the provider from the proxied sandbox request host.
3. Broker loads stored user OAuth tokens for the credential context.
4. If the token is near expiry, broker refreshes it server-side.
5. Broker returns a short-lived `CredentialLease`.
6. Runtime injects provider headers at the sandbox egress proxy boundary and exposes only declared sandbox command env or placeholder values inside the sandbox.

## State management

### OAuth state

- Key pattern: `oauth-state:<random-hex>`
- Value: `{ userId, provider, channelId?, threadTs?, pendingMessage?, configuration?, resumeConversationId?, resumeSessionId? }`
- TTL: 10 minutes
- One-time use: deleted after successful code exchange
- Storage: `StateAdapter`

Purpose:

- binds the authorization link to the requesting user
- carries enough context to resume the blocked Slack thread
- snapshots configuration relevant to the resumed run

### Thread-local pending auth

- Stored in persisted thread conversation state, not in `activeTurnId`
- Value: `{ kind, provider, actorId, sessionId, scope?, linkSentAtMs }`
- Purpose:
  - remembers which blocked request is eligible for auto-resume
  - deduplicates repeated prompts only when `kind`, `provider`, `actorId`,
    `scope`, and `sessionId` all match a fresh already-sent private link
  - lets callbacks suppress stale resumes after newer thread activity
- Callback freshness uses the latest real human request in the thread:
  - bot-authored messages do not own user authorization and are ignored
  - skipped `side_conversation:` and `directed_to_other_party:` messages are ignored
  - failed human turns and thread opt-out messages are newer relevant requests
- This state is callback routing and dedupe state only. It must not be rendered
  into the prompt as an auth-completion hint. Model-visible authorization
  completion is represented by the agent session log's `authorization_completed`
  event and its deterministic Pi projection.

### User tokens

- Key pattern: `oauth-token:<userId>:<provider>`
- Value:
  `{ accessToken, refreshToken, expiresAt?, refreshTokenExpiresAt?, scope? }`
- TTL: derived from `refreshTokenExpiresAt` when known, otherwise from
  `expiresAt` when known, otherwise long-lived host storage
- Storage: `StateAdapterTokenStore`

### MCP auth sessions and credentials

- Session key pattern: `junior:mcp_auth_session:<state>`
- Session index key pattern: `junior:mcp_auth_session_index:<userId>:<provider>`
- Credentials key pattern: `junior:mcp_auth_credentials:<userId>:<provider>`
- Server session key pattern: `junior:mcp_server_session:<userId>:<provider>`

MCP credentials and server session ids are host-managed only. They are never injected into the sandbox or surfaced to the model.

## Base URL resolution

The OAuth `redirect_uri` is resolved in order:

1. `JUNIOR_BASE_URL`
2. `VERCEL_PROJECT_PRODUCTION_URL`
3. `VERCEL_URL`

The same base URL must be registered in the provider's OAuth app configuration.

## Provider configuration

Providers define OAuth through plugin manifests:

```ts
{
  clientIdEnv: string;
  clientSecretEnv: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  scope?: string;
  authorizeParams?: Record<string, string>;
  tokenAuthMethod?: "body" | "basic";
  tokenExtraHeaders?: Record<string, string>;
  callbackPath: string;
}
```

## Security invariants

- Authorization links are delivered privately to the requesting user only.
- The runtime must not post the authorization URL into the public thread. Slack-thread acknowledgements for auth pauses must stay URL-free and only say that authorization is needed and the private link was sent.
- Authorization URLs are never returned to the model.
- Tokens are stored server-side and never appear in sandbox files or model-visible tool arguments.
- Leases are credential-context-bound; sandbox egress leases are issued lazily when forwarded provider traffic needs them and are scoped to the signed credential/sandbox context plus lease expiry.
- Target-aware providers may narrow leases only from explicit provider/request context, not guessed command intent.

## Disconnect behavior

Stored provider credentials may be deleted by host-managed account-management surfaces such as App Home disconnect. This is not part of the model-facing tool surface.
