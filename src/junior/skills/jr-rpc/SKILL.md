---
name: jr-rpc
description: Manage capability credentials and OAuth flows via jr-rpc bash commands.
allowed-tools: bash
---

# jr-rpc Capability Command

Use this skill when a task needs authenticated API calls and credentials are not enabled yet.

## Credential issuance

`jr-rpc issue-credential <capability> [--repo <owner/repo>]`

Example:

`jr-rpc issue-credential github.issues.write --repo getsentry/junior`

## OAuth authorization

`jr-rpc oauth-start <provider>` — initiate authorization code flow, returns `{ ok, authorize_url }`.

## Token management

`jr-rpc delete-token <provider>` — remove stored tokens for current user.

## Behavior

- `jr-rpc` runs as a bash runtime custom command.
- Runtime lazily issues a short-lived lease for this turn and applies sandbox header transforms.
- Raw tokens are never written into sandbox env/files.
- OAuth flows use authorization code grant — the callback handler exchanges the code and stores tokens server-side. The agent never sees token values.

## Guardrails

- Use provider-qualified capabilities (for example `github.issues.write`).
- Do not print credential values.

## References

- [references/commands.md](references/commands.md)
- [references/capabilities.md](references/capabilities.md)
