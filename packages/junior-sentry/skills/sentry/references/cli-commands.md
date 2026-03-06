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

### Explain issue

```bash
sentry issues explain ISSUE_ID --org ORG [--json]
```

AI-powered root cause analysis for a specific issue.

### Plan fix

```bash
sentry issues plan ISSUE_ID --org ORG [--json]
```

AI-powered remediation guidance for a specific issue.

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
