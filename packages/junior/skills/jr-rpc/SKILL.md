---
name: jr-rpc
description: Issue capability credentials and manage OAuth flows via jr-rpc bash commands. Use when a task needs authenticated API calls, credentials are not enabled, or a user needs to connect or disconnect a provider account.
allowed-tools: bash
---

# jr-rpc

Enable provider credentials and manage OAuth authorization for the current agent turn.

## Credential issuance

Run before any authenticated API call:

`jr-rpc issue-credential <capability> [--repo <owner/repo>]`

- Use the exact capability name declared by the loaded skill's `requires-capabilities` metadata or the runtime provider-capabilities catalog.
- Repo-targeted capabilities require `--repo`, unless the target provider already has a configured default repository key.
- Capabilities without repo targets do not use `--repo`.
- On success, sandbox header transforms are applied for this turn. Do not pass raw tokens.
- If credential issuance fails with `credential_unavailable` + `oauth_started`, relay the `message` field to the user and **stop the turn** — the callback auto-resumes the request after authorization.

## OAuth authorization

`jr-rpc oauth-start <provider>` — explicitly start an OAuth authorization code flow without auto-resume.

- The authorization link is delivered privately (visible only to the requesting user).
- Returns `{ ok: true, private_delivery_sent: true }` on success.
- If `private_delivery_sent` is false, tell the user to send a direct message and try again.
- If the user is already connected, returns `{ ok: true, already_connected: true, message }`.
- **Never** post or relay authorization URLs — they are security-sensitive.

## Token management

`jr-rpc delete-token <provider>` — remove stored OAuth tokens for the current user.

## Configuration

`jr-rpc config get|set|unset|list` — read and write channel-scoped configuration values.

- Choose config keys from the runtime provider-capabilities catalog or the active skill's `uses-config` metadata.

Read `${CLAUDE_SKILL_ROOT}/references/commands.md` for full command syntax and response shapes.

Read `${CLAUDE_SKILL_ROOT}/references/capabilities.md` for capability naming and scoping rules.

## Guardrails

- Use exact capability and config key names from the loaded skill or provider catalog; do not invent them.
- Do not print credential values.
