# jr-rpc command reference

## Syntax

### Execute with injected credentials

`jr-rpc credential exec --cap <capability> --repo <owner/repo> -- <command>`

### Issue metadata for debugging

`jr-rpc credential issue --cap <capability> --repo <owner/repo> --format token|env|json`

## Behavior

- `credential exec`:
  - Issues a short-lived credential lease.
  - Injects env vars only for the nested command.
  - Returns nested command output.

- `credential issue`:
  - Issues a short-lived credential lease.
  - Returns metadata/redacted env key info only.
  - Does not expose token values.

## Common errors

- `jr-rpc credential command requires --cap`
- `jr-rpc credential command requires --repo`
- `jr-rpc credential exec requires a command after --`
- Provider auth/config errors (for example missing host app credentials).

## Practical tips

- Use repo-local absolute paths in sandbox commands (for example `/vercel/sandbox/...`).
- Keep the nested command simple and deterministic.
- If a command fails, re-run with narrowed scope and inspect stderr.
