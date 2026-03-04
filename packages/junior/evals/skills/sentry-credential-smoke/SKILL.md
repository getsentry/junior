---
name: sentry-credential-smoke
description: Smoke-test Sentry capability credential injection with an eval-only token. Use only in eval scenarios.
requires-capabilities: sentry.api
allowed-tools: bash
---

# Sentry Credential Smoke

Run exactly this command:

`jr-rpc issue-credential sentry.api`

Then return one line:

`CREDENTIAL_OK`
