# OAuth Flows Spec

## Metadata

- Created: 2026-03-03
- Last Edited: 2026-03-20

## Changelog

- 2026-03-03: Standardized metadata headers and reconciled spec references/structure.
- 2026-03-09: Added provider-configured token request auth/headers and optional token expiry semantics.
- 2026-03-13: Documented MCP challenge-driven OAuth, MCP callback routing, and auth-driven turn resume.
- 2026-03-18: Clarified lazy MCP auth-session creation, host-managed MCP server-session storage, and disconnect cleanup for stored credentials plus pending auth sessions.
- 2026-03-20: Removed stale slash-command examples in favor of generic connect/disconnect requests and direct jr-rpc initiation.

## Status

Active

## Related

- [Security Policy](./security-policy.md)
- [Skill Capabilities Spec](./skill-capabilities-spec.md)

## Purpose

Define how Junior handles OAuth-based user authentication for third-party providers. Junior is a Hono web service with public HTTPS endpoints, so it uses the **Authorization Code Grant** (RFC 6749 §4.1) — the standard flow for server-side web applications.

## Architecture

### Components

| Component                            | Role                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `jr-rpc oauth-start <provider>`      | Generates state, stores in Redis, sends ephemeral link to user                                           |
| `/api/oauth/callback/[provider]`     | Exchanges code for tokens, stores server-side, auto-resumes pending request or posts thread confirmation |
| `/api/oauth/callback/mcp/[provider]` | Completes MCP SDK authorization and resumes the paused MCP-backed turn session                           |
| `StateAdapterTokenStore`             | Redis-backed `UserTokenStore` for persistent token storage                                               |
| MCP auth session store               | Stores MCP auth session context and SDK-managed OAuth state across the browser redirect                  |
| `OAuthBearerBroker`                  | Issues short-lived credential leases from stored user tokens                                             |

### Why authorization code grant

Junior runs as a Hono service on Vercel with public HTTPS routes. Authorization code grant is the correct choice because:

- Standard click-to-authorize UX (user clicks link, approves, gets redirected back).
- No polling — callback handler completes the flow in a single request.
- Token values never appear in tool call arguments or conversation context.
- Code exchange happens server-side with `client_secret` — tokens are never exposed to the agent.

Device code grant (RFC 8628) was rejected because it requires agent-side polling loops that consume turns and risk timeouts, and `store-token` commands would leak raw token values through tool call arguments visible in conversation context.

## Flow

### Authorization (connect)

```
User: asks Junior to connect their Sentry account in a Slack thread
  │
  ▼
Agent: jr-rpc oauth-start sentry
  │
  ├─ Validate provider has OAuth config
  ├─ Read client_id from host env
  ├─ Generate random state token (32 bytes hex)
  ├─ Store { userId, provider, channelId, threadTs, pendingMessage?, configuration? } in Redis
  │   key `oauth-state:<state>`, 10-min TTL
  ├─ Build authorize URL with client_id, state, redirect_uri, response_type=code, optional scope, and any provider authorize params
  ├─ Send authorize URL as ephemeral Slack message (only visible to the user)
  ├─ If ephemeral fails: send as DM to the user (still private)
  └─ Return { ok: true, private_delivery_sent: true }
  │
  ▼
Agent: Tells user a private authorization link was sent, turn ends
  │
  ▼
User: Sees ephemeral message with clickable link → opens provider authorization page → approves
  │
  ▼
Provider: Redirects to /api/oauth/callback/<provider>?code=...&state=...
  │
  ├─ Look up `oauth-state:<state>` from Redis → { userId, provider, channelId, threadTs }
  ├─ Validate provider matches
  ├─ Delete state key (one-time use)
  ├─ POST to token endpoint using provider-configured auth method and headers
  ├─ Store tokens via UserTokenStore (Redis key `oauth-token:<userId>:<provider>`)
  ├─ If pendingMessage: after() triggers generateAssistantReply and posts result to thread
  ├─ Else: post confirmation message into Slack thread (best effort, via SLACK_BOT_TOKEN)
  └─ Return HTML success page to browser
  │
  ▼
User: Sees "account connected" in browser; if pending, sees resumed response in thread
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
  ├─ Turn checkpoint is written as `awaiting_resume` with `resume_reason=auth`
  └─ Current turn exits with retryable resume semantics
  │
  ▼
User: opens the private link, approves, provider redirects to /api/oauth/callback/mcp/<provider>?code=...&state=...
  │
  ├─ Callback loads MCP auth session by `state`
  ├─ SDK completes OAuth via `finishAuth(code)` and persists tokens
  ├─ after() resumes the same `(conversation_id, session_id)` turn context
  └─ Resumed turn rebuilds loaded skills + active MCP providers, then calls `continue()`
  │
  ▼
User: sees the original thread continue without reissuing the request
```

### Credential issuance (per-turn)

After a user has connected their account, credential issuance works transparently:

1. Agent runs `jr-rpc issue-credential <capability>`.
2. `OAuthBearerBroker.issue()` looks up stored tokens by `requesterId` + provider.
3. If token is near expiry, broker refreshes via `grant_type=refresh_token` and updates the store.
4. Broker returns a `CredentialLease` with header transforms.
5. Runtime applies `Authorization` header on matching domain for the rest of the turn.

### Disconnect

```
User: asks Junior to disconnect their Sentry account
  │
  ▼
Agent: jr-rpc delete-token sentry
  │
  ├─ Deletes Redis key `oauth-token:<userId>:<provider>` when present
  ├─ Deletes Redis key `junior:mcp_auth_credentials:<userId>:<provider>` for MCP-backed providers
  ├─ Deletes pending MCP auth-session entries for that `<userId>:<provider>` pair
  └─ Returns confirmation
```

## State management

### OAuth state (CSRF protection + thread context)

- Key pattern: `oauth-state:<random-hex>`
- Value: `{ userId: string, provider: string, channelId?: string, threadTs?: string, pendingMessage?: string, configuration?: Record<string, unknown> }`
- TTL: 10 minutes
- One-time use: deleted after successful code exchange
- Storage: `StateAdapter` (Redis)
- `channelId`/`threadTs` enable the callback to post a confirmation message back into the originating Slack thread
- `pendingMessage` stores the original user request so the callback can auto-resume an agent turn after auth completes
- `configuration` snapshots channel config values (e.g. `sentry.org`) so the resumed turn has the same context

### User tokens (persistent)

- Key pattern: `oauth-token:<userId>:<provider>`
- Value: `{ accessToken, refreshToken, expiresAt? }`
- TTL: `expiresAt - now + 24h` buffer when expiry is known, otherwise 365 days
- Storage: `StateAdapterTokenStore` wrapping `StateAdapter` (Redis)

### MCP auth sessions and credentials

- Session key pattern: `junior:mcp_auth_session:<state>`
- Session index key pattern: `junior:mcp_auth_session_index:<userId>:<provider>`
- Session value: `{ provider, userId, conversationId, sessionId, userMessage, channelId?, threadTs?, toolChannelId?, configuration?, artifactState?, authorizationUrl?, codeVerifier? }`
- Session TTL: 24 hours
- Session records are created lazily when the MCP SDK first needs to redirect the user for authorization, not on every MCP client activation.
- Disconnect must clear both stored MCP credentials and any pending indexed auth sessions for that `userId:provider` pair so stale private links cannot reconnect an unlinked account.
- Credentials key pattern: `junior:mcp_auth_credentials:<userId>:<provider>`
- Credentials value: MCP SDK client information, discovery state, and OAuth tokens
- Credentials TTL: 30 days, refreshed on every write
- Server session key pattern: `junior:mcp_server_session:<userId>:<provider>`
- Server session value: `{ sessionId, updatedAtMs }`
- Server session TTL: 24 hours
- Server session ids are opaque server-issued transport state. They are stored only in host-managed state, never injected into the sandbox or surfaced to the agent, and are cleared on disconnect or when the MCP server reports the session is missing.

## Base URL resolution

The OAuth `redirect_uri` requires the application's base URL. Resolved in order:

1. `JUNIOR_BASE_URL` env var (explicit override)
2. `VERCEL_PROJECT_PRODUCTION_URL` (auto-set by Vercel, prefixed with `https://`)
3. `VERCEL_URL` (deployment-specific fallback, prefixed with `https://`)

The same base URL must be registered in the provider's OAuth app configuration.

## Provider configuration

Providers are configured via plugin manifests (`plugin.yaml`) and exposed through `getOAuthProviderConfig()` (`jr-rpc-command.ts`):

```typescript
{
  clientIdEnv: string;       // env var name for client ID
  clientSecretEnv: string;   // env var name for client secret
  authorizeEndpoint: string; // provider's authorization URL
  tokenEndpoint: string;     // provider's token exchange URL
  scope?: string;            // OAuth scope string
  authorizeParams?: Record<string, string>; // extra authorize URL params
  tokenAuthMethod?: "body" | "basic";       // token client auth method
  tokenExtraHeaders?: Record<string, string>; // extra token request headers
  callbackPath: string;      // path segment for redirect_uri
}
```

### Sentry

- `clientIdEnv`: `SENTRY_CLIENT_ID`
- `clientSecretEnv`: `SENTRY_CLIENT_SECRET`
- Authorize: `https://sentry.io/oauth/authorize/`
- Token: `https://sentry.io/oauth/token/`
- Scope: `event:read org:read project:read`
- Callback: `/api/oauth/callback/sentry`

### MCP-backed plugins

- Plugin manifests may also declare `mcp.transport: http` and `mcp.url`.
- MCP headers are optional but may not include `Authorization`.
- MCP callback path is `/api/oauth/callback/mcp/<plugin>`.
- MCP OAuth is challenge-driven by the SDK rather than initiated through `jr-rpc oauth-start`.

## Security properties

- **Authorization links are private**: Authorization URLs contain user-specific CSRF state tokens and must **only** be visible to the requesting user. Delivered via `chat.postEphemeral` in channels or `chat.postMessage` in 1:1 DMs. If private delivery fails, falls back to a DM to the user. Authorization URLs are **never** posted as visible messages in channels or returned to the agent.
- **Agent never sees tokens or authorization URLs**: `oauth-start` sends the URL directly to the user via ephemeral/DM message. The agent never receives the URL. Token exchange happens in the callback route.
- **CSRF protection**: Random state parameter with short TTL, validated on callback.
- **One-time state**: State key deleted after use — replay not possible.
- **Server-side secrets**: `client_secret` is read from host env, never exposed to sandbox or agent.
- **Token refresh on host**: Broker refreshes expired tokens server-side, agent only receives header transforms.
- **Scoped storage**: Tokens keyed by `userId:provider` — users cannot access each other's tokens.
- **MCP links remain private**: MCP authorization URLs are also delivered through the same private Slack delivery rules and are never emitted as visible thread messages.
- **Resumed tool universe is stable**: MCP auth resume restores the checkpointed loaded skills and active MCP providers before continuing the same turn session.
- **Resumed thread context is stable**: MCP auth resume also restores snapshotted configuration, artifact state, and tool-channel targeting before the resumed turn continues.

## Slack chat experience

This section describes what the user actually sees in their Slack thread for each scenario.

### Identity

- Tokens are keyed by Slack user ID, not channel. A user who connects in one channel is connected everywhere.
- Each user connects their own provider account independently — there is no workspace-wide token.

### Connect

What the thread looks like:

```
User:     @Junior connect my Sentry account
Junior:   I've sent you a private link to connect your Sentry account.
          [ephemeral — only this user sees: "Click here to connect your Sentry account" with link]
          ... user clicks link, authorizes in browser, sees "Sentry account connected" page ...
Junior:   Your Sentry account is now connected. You can continue with Sentry requests.
```

Three messages from Junior appear in the thread:

1. **Agent reply** (visible to all): "I've sent you a private link..." — the agent's normal text response posted via `thread.post()`.
2. **Private link** (visible only to requesting user): the clickable authorization URL, sent by `oauth-start` via `chat.postEphemeral` (channels) or `chat.postMessage` (1:1 DMs). Falls back to a DM if in-context delivery fails. Other channel members never see this. The authorization URL is **never** posted as a visible channel message or returned to the agent.
3. **Callback confirmation** (visible to all): "Your Sentry account is now connected." — posted by the OAuth callback handler via `chat.postMessage` after the user finishes authorizing.

The user also sees a success page in their browser after authorizing, telling them to close the tab and return to Slack.

What happens under the hood:

```
1. User asks Junior to connect their Sentry account
2. Agent turn starts
   a. Agent detects an explicit Sentry connect request
   b. Runs `jr-rpc oauth-start sentry`
   c. oauth-start: stores { userId, provider, channelId, threadTs } in Redis (10-min TTL)
   d. oauth-start: sends authorize URL privately via SLACK_BOT_TOKEN (ephemeral in channels, DM fallback)
   e. oauth-start: returns { ok: true, private_delivery_sent: true }
   f. Agent replies: "I've sent you a private link..."
   g. Agent turn ends
3. User sees ephemeral message, clicks link → opens Sentry authorization page
4. User clicks "Authorize" on Sentry's page
5. Sentry redirects browser to /api/oauth/callback/sentry?code=...&state=...
6. Callback handler (separate HTTP request, not an agent turn):
   a. Looks up OAuth state from Redis → gets { userId, provider, channelId, threadTs }
   b. Deletes state key (one-time use)
   c. Exchanges code for tokens via Sentry token endpoint
   d. Stores tokens in Redis (key: oauth-token:<userId>:sentry)
   e. Posts confirmation into Slack thread via chat.postMessage + SLACK_BOT_TOKEN
   f. Returns HTML success page to browser
7. User sees confirmation in both browser and Slack thread
```

### Already connected (normal use)

What the thread looks like:

```
User:     @Junior show me recent Sentry issues
Junior:   [responds with issue list — no auth prompts, no delays]
```

The auth machinery is invisible. On every turn, the broker looks up stored tokens from Redis, refreshes if needed, and injects headers. The user never sees this.

### Token refresh

What the thread looks like:

```
User:     @Junior show me recent Sentry issues
Junior:   [responds normally — identical to above]
```

If the access token is within 5 minutes of expiry, the broker silently refreshes it via `grant_type=refresh_token`, updates Redis, and proceeds. The user sees no difference.

### Token expired and refresh fails

What the thread looks like:

```
User:     @Junior show me recent Sentry issues
Junior:   I need to reconnect your Sentry account. I've sent you a private authorization link.
          [ephemeral — only this user sees: "Click here to connect your Sentry account" with link]
          ... user clicks link, authorizes in browser ...
Junior:   Your Sentry account is now connected. Processing your request...
Junior:   [issue list results]
```

This happens when the refresh token itself is revoked or Sentry's token endpoint is unreachable. The broker throws `CredentialUnavailableError`, and `issue-credential` auto-starts the OAuth flow with the pending message — same as the first-time connect scenario.

### Not connected (first Sentry command — auto-resume)

What the thread looks like:

```
User:     @Junior show me recent Sentry issues
Junior:   I need to connect your Sentry account first. I've sent you a private link.
          [private — only this user sees: "Click here to connect your Sentry account" with link]
          ... user clicks link, authorizes in browser ...
Junior:   Your Sentry account is now connected. Processing your request...
Junior:   [issue list results]
```

The broker throws `CredentialUnavailableError`. The harness (`issue-credential` handler) catches this, detects the provider supports OAuth, and automatically starts the OAuth flow — storing the original user message and channel configuration snapshot in the OAuth state. The agent sees `{ credential_unavailable, oauth_started, private_delivery_sent, message }` and relays the `message` to the user. After the user authorizes, the callback stores tokens and triggers a new agent turn in the background (via `after()`) that processes the original request.

What happens under the hood:

```
1. User asks Junior to show recent Sentry issues
2. Agent turn starts
   a. Agent loads sentry skill, runs jr-rpc issue-credential sentry.api
   b. Broker throws CredentialUnavailableError("sentry", ...)
   c. issue-credential handler catches it, calls startOAuthFlow("sentry") internally
   d. startOAuthFlow: stores { userId, provider, channelId, threadTs, pendingMessage, configuration } in Redis
   e. startOAuthFlow: sends authorize URL privately (ephemeral or DM fallback)
   f. issue-credential returns: { credential_unavailable, oauth_started, private_delivery_sent, message }
   g. Agent relays `message` to user
   h. Agent turn ends
3. User clicks ephemeral link → authorizes on Sentry → redirected to callback
4. Callback handler:
   a. Exchanges code for tokens, stores in Redis
   b. Returns HTML success page to browser
   c. after(): posts "Your Sentry account is now connected. Processing your request..."
   d. after(): calls generateAssistantReply("show me recent Sentry issues", { configuration, ... })
   e. after(): posts the agent's reply to the Slack thread
5. User sees results without any additional action
```

### Disconnect

What the thread looks like:

```
User:     @Junior disconnect my Sentry account
Junior:   Your Sentry account has been disconnected.
```

Under the hood: `jr-rpc delete-token sentry` deletes the stored provider credentials, including MCP OAuth credentials for MCP-backed providers. Future commands will prompt the user to reconnect.

### Design notes

**Private authorize link.** The authorization URL is delivered privately so only the requesting user sees it. The URL contains a user-specific CSRF state token — keeping it private prevents other channel members from completing OAuth on behalf of another user. Delivery strategy: `chat.postEphemeral` in channels, `chat.postMessage` in 1:1 DMs, DM fallback via `conversations.open` if in-context delivery fails. The authorization URL is **never** returned to the agent or posted as a visible channel message — this is a hard security invariant. The jr-rpc `oauth-start` handler posts the message directly via `SLACK_BOT_TOKEN`, not through the Chat SDK, because the thread handle is not available at the jr-rpc layer.

**Ephemeral fallback.** If ephemeral delivery fails (e.g. Slack API error), the system attempts to send the authorization link as a DM to the user. If DM delivery also fails (missing `SLACK_BOT_TOKEN`, user has DMs disabled), the command returns an error instructing the user to DM the bot directly. Authorization URLs are **never** returned to the agent or posted as visible messages — this is a hard security invariant.

**Callback confirmation is best effort.** The callback posts into the originating Slack thread using thread coordinates stored in the OAuth state. This is a direct `chat.postMessage` via `SLACK_BOT_TOKEN`. If the Slack post fails, the user still sees success in the browser, and their next command will work.

**Callback message does not trigger a new agent turn.** The confirmation is posted using the bot token, so `message.author.isMe` is true. The `onSubscribedMessage` handler already returns early for self-messages (bot.ts line 1406). No infinite loop.

**Auto-resume via `waitUntil`.** When `pendingMessage` is stored in the OAuth state, the callback uses `waitUntil` to trigger `generateAssistantReply()` in the background after the HTTP response is sent. The reply is posted to the thread via `chat.postMessage`. Channel configuration values are snapshotted at `issue-credential` time and passed as a read-only `ChannelConfigurationService` so `jr-rpc config get` works in the resumed context. If the resumed turn fails, a fallback message asks the user to retry.

**Harness-driven auto-start.** The agent never passes pending message context. When `issue-credential` fails with `CredentialUnavailableError` for an OAuth-capable provider, the harness automatically starts the OAuth flow with the original user message (from `JrRpcDeps.userMessage`) and channel configuration stored in the OAuth state. The agent only needs to interpret the `credential_unavailable` + `oauth_started` result and inform the user.

**Explicit connect requests via `oauth-start` skip auto-resume.** When the user explicitly requests account connection via `oauth-start`, no `userMessage` is stored (the connect request itself is the intent), and the callback posts a simple "connected" confirmation without triggering an agent turn.

## Adding a new provider

1. Create a plugin directory under `plugins/<name>/` with a `plugin.yaml` manifest declaring `oauth` configuration (see `specs/plugin-spec.md`).
2. Register the OAuth app with the provider, setting redirect URI to `<base-url>/api/oauth/callback/<name>`.
3. Add `<PROVIDER>_CLIENT_ID` and `<PROVIDER>_CLIENT_SECRET` env vars.
4. Create the provider's skills in `plugins/<name>/skills/`.
