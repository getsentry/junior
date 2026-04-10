# Sentry CLI Command Reference

All commands use `sentry` and read `SENTRY_AUTH_TOKEN` from environment.

## Issue commands

### List issues

```bash
sentry issues list --org ORG [--project PROJECT] [--query QUERY] [--json]
```

- `--org`: Organization slug (required).
- `--project`: Project slug (optional, omit for org-wide).
- `--query`: Sentry search query (e.g., `user.email:alice@example.com`, `is:unresolved`).
- `--json`: Output as JSON for structured parsing.

## Organization commands

### List organizations

```bash
sentry organizations list [--json]
```

Lists organizations accessible with current token.

## Common flags

- `--json`: Structured JSON output (preferred for parsing).
- `--org ORG`: Organization slug.
- `--project PROJECT`: Project slug.
- `--log-level`: `debug`, `info`, `warn`, `error`.

Only use commands listed in this reference during normal skill execution. If a command reports explicit missing scopes, reconnect the Sentry account to refresh the grant. Treat generic permission or org/project access errors as access problems rather than retryable auth refresh problems.
