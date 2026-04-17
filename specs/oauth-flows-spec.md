# OAuth Flows Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-04-17

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-09: Added provider-configured token request auth/headers and optional token expiry semantics.
- 2026-03-13: Documented MCP challenge-driven OAuth, MCP callback routing, and auth-driven turn resume.
- 2026-04-17: Removed explicit model-facing auth commands and documented implicit runtime-owned OAuth initiation for plugin-backed commands.

## Status

Active

## Related

- [Security Policy](./security-policy.md)
- [Skill Capabilities Spec](./skill-capabilities-spec.md)

## Purpose

Define how Junior handles per-user OAuth for third-party providers while keeping authorization links and token values out of model-visible context.

## Architecture

### Components

| Component                            | Role                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `startOAuthFlow(provider, ...)`      | Internal runtime helper that creates state and privately delivers the authorization link                            |
| `/api/oauth/callback/[provider]`     | Exchanges code for tokens, stores them server-side, and resumes the paused thread                                   |
| `/api/oauth/callback/mcp/[provider]` | Completes MCP SDK authorization and resumes the paused MCP-backed turn session                                      |
| `StateAdapterTokenStore`             | Persistent per-user token storage                                                                                   |
| MCP auth session store               | Stores MCP auth session context and SDK-managed OAuth state across the browser redirect                             |
| `OAuthBearerBroker`                  | Issues short-lived turn leases from stored user tokens                                                              |
| `PluginAuthOrchestration`            | Detects missing/stale provider auth, starts OAuth privately, and turns the current turn into a resumable auth pause |

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
  ├─ Runtime resolves provider from the loaded skill
  ├─ Runtime keeps any provider defaults (for example a repo config) available for command construction
  ├─ Broker checks requester-bound stored tokens
  ├─ If auth is missing or stale:
  │    • runtime creates OAuth state
  │    • runtime privately delivers the authorization link
  │    • runtime checkpoints the turn as awaiting auth resume
  └─ Current turn exits with retryable resume semantics
  │
  ▼
User: opens private link and approves
  │
  ▼
Provider: redirects to /api/oauth/callback/<provider>?code=...&state=...
  │
  ├─ Callback validates state and provider match
  ├─ Callback exchanges code for tokens
  ├─ Callback stores tokens by requester ID + provider
  ├─ Callback refreshes App Home connected-account state (best effort)
  └─ Callback resumes the paused turn or replays the pending message when needed
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
  ├─ Turn checkpoint is written as awaiting auth resume
  └─ Current turn exits with retryable resume semantics
  │
  ▼
User: opens the private link and approves
  │
  ▼
Provider: redirects to /api/oauth/callback/mcp/<provider>?code=...&state=...
  │
  ├─ Callback loads MCP auth session by state
  ├─ SDK completes OAuth and persists tokens
  └─ Callback resumes the same paused turn context
```

## Credential issuance

After a user has connected their account:

1. Agent runs an authenticated provider command under a loaded plugin-backed skill.
2. Runtime resolves the provider from the loaded skill for the resumed turn.
3. Broker loads stored requester-bound tokens.
4. If the token is near expiry, broker refreshes it server-side.
5. Broker returns a short-lived `CredentialLease`.
6. Runtime injects provider headers and placeholder env vars for the rest of the current turn only.

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
- snapshots configuration relevant to the resumed turn

### User tokens

- Key pattern: `oauth-token:<userId>:<provider>`
- Value: `{ accessToken, refreshToken, expiresAt?, scope? }`
- TTL: derived from expiry when known, otherwise long-lived host storage
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
- Authorization URLs are never returned to the model.
- Tokens are stored server-side and never appear in sandbox files or model-visible tool arguments.
- Leases are requester-bound and turn-scoped.
- Target-aware providers may narrow leases to repo/project/org scope when available.

## Disconnect behavior

Stored provider credentials may be deleted by host-managed account-management surfaces such as App Home disconnect. This is not part of the model-facing tool surface.
