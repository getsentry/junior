# Design: `oauth-flows`

## Goals

- Keep authorization links private to the requesting user.
- Keep OAuth codes, access tokens, refresh tokens, MCP credentials, and authorization URLs out of model-visible context.
- Park blocked turns at resumable session boundaries and resume from durable history.
- Model authorization completion as chronological session history, not as a prompt flag.
- Suppress stale callback resumes when newer thread activity has superseded the blocked request.

## Non-Goals

- Specify provider credential header injection; that belongs to `credential-injection`.
- Specify plugin manifest parsing; this capability consumes OAuth and MCP declarations.
- Specify final Slack delivery chunking beyond callback resume ownership.
- Support scheduled-run interactive auth; scheduler specs disable interactive auth for autonomous runs.

## Prior Art Summary

OAuth 2.0 authorization code grant is the standard server-side flow where a provider redirects back with an authorization code and the server exchanges it for tokens. OAuth refresh grants let the server obtain new access tokens from refresh tokens without exposing tokens to the agent. MCP HTTP authorization builds on OAuth and treats authorization as a transport/client responsibility for protected MCP resources. Agent runtimes such as Claude Code and Codex treat permissions/approvals as host-controlled runtime gates rather than prompt text; Junior should do the same for provider authorization. Slack apps can privately deliver sensitive links with ephemeral messages in channels or direct messages, while public thread acknowledgements must remain URL-free.

Sources:

- OAuth 2.0 RFC 6749: https://www.rfc-editor.org/rfc/rfc6749
- MCP Authorization: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Codex approvals: https://www.mintlify.com/openai/codex/concepts/approvals
- Slack `chat.postEphemeral`: https://api.slack.com/methods/chat.postEphemeral

## Decisions

### Authorization Is A Runtime Interrupt

When plugin or MCP work needs authorization, the runtime sends/reuses a private link, posts a URL-free public acknowledgement, appends `authorization_requested`, persists the turn as awaiting auth resume, and parks the current slice. The model should not receive raw auth URLs or prompt-only lifecycle flags.

### Completion Is Session History

Callbacks append `authorization_completed` before the resumed turn starts. Pi projection materializes this as a concise host-authored observation in chronological order. `pendingAuth` remains callback routing/dedupe state only.

### Plugin And MCP Flows Share Resume Semantics

Generic plugin OAuth stores provider state under `oauth-state:<state>`. MCP OAuth stores SDK-managed session/credentials/server-session state under MCP-specific keys. Both callbacks resume only if the pending auth target is still the latest relevant request.

### Private Delivery Must Fail Closed

If Junior cannot privately deliver the authorization link, it must not post the link publicly. The turn should fail or instruct the user to DM the bot instead of leaking a URL.

## Open Design Questions

- Whether generic OAuth state should be one-time deleted before or after successful token exchange for better retry behavior.
- Whether authorization_completed should be recorded when callback stores tokens but suppresses stale resume.
- Whether reconnect-only requests should always resume the original turn or may post a simple connected confirmation.
- Whether public URL-free acknowledgements should have a single shared wording owner in Slack delivery specs.
- Whether pendingAuth should move fully out of conversation state into a dedicated auth-routing store.
