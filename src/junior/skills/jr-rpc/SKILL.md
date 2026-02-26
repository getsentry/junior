---
name: jr-rpc
description: Use host-mediated credential issuance for sandbox commands via jr-rpc. Use when a task needs short-lived provider credentials (for example GitHub) to run a command safely.
allowed-tools: bash
---

# jr-rpc Credential Usage

Use this skill when a command needs temporary credentials injected by the harness.

## Primary pattern

Use `credential exec` so credentials are injected only for the nested command:

`jr-rpc credential exec --cap <capability> --repo <owner/repo> -- <command>`

Example:

`jr-rpc credential exec --cap github.issues.write --repo getsentry/junior -- node /vercel/sandbox/skills/gh-issue/scripts/gh_issue_api.mjs create --repo getsentry/junior --title "..." --body-file /tmp/body.md`

## Secondary pattern

`credential issue` is for diagnostics/metadata only:

`jr-rpc credential issue --cap <capability> --repo <owner/repo> --format token|env|json`

Notes:
- Output is redacted metadata (no raw token values).
- Prefer `credential exec` for real work.

## Guardrails

- Never print, echo, or log credential values.
- Do not write credentials to files.
- Avoid shell debug tracing (`set -x`) when running credentialed commands.
- Keep repo target explicit via `--repo owner/repo`.

## Capability examples

- `github.issues.read`
- `github.issues.write`
- `github.issues.comment`
- `github.labels.write`

## References

- [references/commands.md](references/commands.md) (overview)
- [references/credential-exec.md](references/credential-exec.md) (`jr-rpc credential exec`)
- [references/credential-issue.md](references/credential-issue.md) (`jr-rpc credential issue`)
