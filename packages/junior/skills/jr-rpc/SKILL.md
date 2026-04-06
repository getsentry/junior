---
name: jr-rpc
description: Issue capability credentials and manage OAuth flows via jr-rpc bash commands. Use when a task needs authenticated API calls, credentials are not enabled, or a user needs to connect or disconnect a provider account.
allowed-tools: bash
uses-config: github.repo
---

# jr-rpc

Enable provider credentials and manage OAuth authorization for the current agent turn.

## Credential issuance

Run before any authenticated API call:

`jr-rpc issue-credential <capability> [--repo <owner/repo>]`

- GitHub capabilities require repository context. Provide `--repo`, or reuse a configured default via `github.repo` when available.
- Sentry capabilities are org-scoped and do not use `--repo`.
- On success, sandbox header transforms are applied for this turn. Do not pass raw tokens.
- If credential issuance fails with `credential_unavailable` + `oauth_started`, relay the `message` field to the user and **stop the turn** — the callback auto-resumes the request after authorization.

## OAuth authorization

`jr-rpc oauth-start <provider>` — start an OAuth authorization code flow.

- The authorization link is delivered privately (visible only to the requesting user).
- For explicit connect or reconnect requests, use `oauth-start` instead of `issue-credential`.
- For disconnect + reconnect requests, run `jr-rpc delete-token <provider>` first, then `jr-rpc oauth-start <provider>`.
- Returns `{ ok: true, private_delivery_sent: true }` on success.
- If `private_delivery_sent` is false, tell the user to send a direct message and try again.
- If the user is already connected, returns `{ ok: true, already_connected: true, message }`.
- After `oauth-start`, tell the user the private link was sent and stop. Do not issue provider capabilities in the same turn just to verify the connection.
- **Never** post or relay authorization URLs — they are security-sensitive.

## Token management

`jr-rpc delete-token <provider>` — remove stored OAuth tokens for the current user.

## Configuration

`jr-rpc config get|set|unset|list` — read and write channel-scoped configuration values.

- Use `jr-rpc config set github.repo <owner/repo>` to store a channel default GitHub repository for later credential issuance.

Read `${CLAUDE_SKILL_ROOT}/references/commands.md` for full command syntax and response shapes.

Read `${CLAUDE_SKILL_ROOT}/references/capabilities.md` for capability naming and scoping rules.

## Guardrails

- Use provider-qualified capabilities (e.g. `github.issues.write`).
- Do not print credential values.
