---
title: Runtime Commands
description: High-value jr-rpc commands for credentials, config, and OAuth.
---

## Credential issuance

```bash
jr-rpc issue-credential <capability>
```

Examples:

```bash
jr-rpc issue-credential github.issues.write
jr-rpc issue-credential sentry.api
```

## Config values

```bash
jr-rpc config get <key>
jr-rpc config set <key> <value>
```

Examples:

```bash
jr-rpc config set github.repo getsentry/junior
jr-rpc config set sentry.org getsentry
jr-rpc config set sentry.project my-project
```

## OAuth lifecycle

```bash
jr-rpc oauth-start sentry
jr-rpc delete-token sentry
```

## Operational guidance

- Issue only the scope needed for the command you are running.
- Treat auth failures as actionable signals, not transient noise.
- Never expose provider token values in output.
