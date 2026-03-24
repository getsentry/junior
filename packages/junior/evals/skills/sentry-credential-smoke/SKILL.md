---
name: sentry-credential-smoke
description: Smoke-test Sentry capability credential injection with an eval-only token. Use only in eval scenarios.
requires-capabilities: sentry.api
allowed-tools: bash
---

# Sentry Credential Smoke

## Step 1: Enable The Credential

Call `bash` with exactly:

`jr-rpc issue-credential sentry.api`

## Step 2: Return The Result

- If the command succeeds, return exactly:

`CREDENTIAL_OK`

- If the command fails, return a short error that includes the command stderr.
