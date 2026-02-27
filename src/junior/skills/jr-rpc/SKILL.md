---
name: jr-rpc
description: Lazily enable capability credentials for this turn via `jr-rpc issue-credential CAPABILITY`.
requires-capabilities: github.issues.read github.issues.write github.issues.comment github.labels.write
uses-config: github.repo
allowed-tools: bash
---

# jr-rpc Capability Command

Use this skill when a task needs authenticated API calls and credentials are not enabled yet.

## Required command form

`jr-rpc issue-credential <capability> [--repo <owner/repo>]`

Example:

`jr-rpc issue-credential github.issues.write --repo getsentry/junior`

## Behavior

- `jr-rpc` runs as a bash runtime custom command.
- Runtime lazily issues a short-lived lease for this turn and applies sandbox header transforms.
- Raw tokens are never written into sandbox env/files.

## Guardrails

- Use provider-qualified capabilities (for example `github.issues.write`).
- Do not print credential values.

## References

- [references/commands.md](references/commands.md)
- [references/capabilities.md](references/capabilities.md)
