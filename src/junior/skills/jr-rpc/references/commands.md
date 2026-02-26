# jrRpc tool reference

## Syntax

### Execute with injected credentials

`jrRpc action=exec capability=<capability> repo=<owner/repo> command='<command>'`

### Issue metadata for debugging

`jrRpc action=issue capability=<capability> repo=<owner/repo> format=token|env|json`

## Behavior

- `action=exec`:
  - Issues a short-lived credential lease.
  - Injects env vars only for the nested command.
  - Returns nested command output.

- `action=issue`:
  - Issues a short-lived credential lease.
  - Returns metadata/redacted env key info only.
  - Does not expose token values.

## Common errors

- `jrRpc requires a non-empty capability`
- `jrRpc requires a non-empty repo`
- `jrRpc exec requires a non-empty command`
- Provider auth/config errors (for example missing host app credentials).

## Practical tips

- Use repo-local absolute paths in sandbox commands (for example `/vercel/sandbox/...`).
- Keep the nested command simple and deterministic.
- If a command fails, re-run with narrowed scope and inspect stderr.
