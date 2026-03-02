# `jr-rpc` command reference

## issue-credential

`jr-rpc issue-credential <capability> [--repo <owner/repo>]`

Enable a capability credential for the current turn.

- `<capability>` — provider-qualified (e.g. `github.issues.write`, `sentry.api`)
- `--repo <owner/repo>` — required for GitHub capabilities, not needed for Sentry

## oauth-start

`jr-rpc oauth-start <provider>`

Initiate an OAuth authorization code flow for the given provider. The command sends the authorization link as an ephemeral Slack message (visible only to the requesting user) and returns:

- `{ ok: true, ephemeral_sent: true }` — link was sent privately. Tell the user you've sent them a private link.
- `{ ok: true, ephemeral_sent: false, authorize_url: "..." }` — ephemeral delivery failed (missing channel context). Post `authorize_url` normally as a fallback.

The user clicks the link, authorizes in browser, and is redirected back to the callback handler which exchanges the code, stores tokens server-side, and posts a confirmation into the thread.

Supported providers: `sentry`

## issue-credential auto-OAuth

When `issue-credential` fails because no credentials are available for an OAuth-capable provider, the harness automatically starts the OAuth flow and returns:

```json
{ "credential_unavailable": true, "oauth_started": true, "provider": "sentry", "ephemeral_sent": true, "message": "I need to connect your Sentry account first. I've sent you a private authorization link." }
```

The `message` field contains the exact text to relay to the user. The callback handler will automatically resume the original user request after authorization completes. The agent should relay `message` and stop the turn.

## delete-token

`jr-rpc delete-token <provider>`

Delete stored OAuth tokens for the current user and provider.

## config

`jr-rpc config get <key>`
`jr-rpc config set <key> <value> [--json]`
`jr-rpc config unset <key>`
`jr-rpc config list [--prefix <value>]`

Read and write channel-scoped configuration values.
