# `jr-rpc` command reference

## issue-credential

`jr-rpc issue-credential <capability> [--repo <owner/repo>]`

Enable a capability credential for the current turn.

- `<capability>` — provider-qualified (e.g. `github.issues.write`, `sentry.api`)
- `--repo <owner/repo>` — required for GitHub capabilities, not needed for Sentry

### Auto-OAuth

When `issue-credential` fails because no credentials are available for an OAuth-capable provider, the harness automatically starts the OAuth flow and returns:

```json
{
  "credential_unavailable": true,
  "oauth_started": true,
  "provider": "sentry",
  "private_delivery_sent": true,
  "message": "I need to connect your Sentry account first. I've sent you a private authorization link."
}
```

Relay the `message` field to the user and stop the turn. The callback handler automatically resumes the original request after authorization completes.

If `private_delivery_sent` is false, the `message` field instructs the user to send a direct message and try again.

## oauth-start

`jr-rpc oauth-start <provider>`

Initiate an OAuth authorization code flow for the given provider without auto-resume. The command sends the authorization link as a private Slack message (visible only to the requesting user).

Use this when the user explicitly asks to connect a provider and there is no pending task to resume after authorization.

Responses:

- `{ ok: true, private_delivery_sent: true }` — link was sent privately. Tell the user you've sent them a private authorization link.
- `{ ok: true, private_delivery_sent: false, message: "..." }` — private delivery failed (missing channel context). Relay the `message` to the user.
- `{ ok: true, already_connected: true, provider: "...", message: "..." }` — user already has a valid token. Relay the `message`.

**Never** post or relay authorization URLs — they are security-sensitive and are only delivered privately.

Supported providers: `sentry`

## delete-token

`jr-rpc delete-token <provider>`

Delete stored OAuth tokens for the current user and provider.

## config

`jr-rpc config get <key>`
`jr-rpc config set <key> <value> [--json]`
`jr-rpc config unset <key>`
`jr-rpc config list [--prefix <value>]`

Read and write channel-scoped configuration values.
