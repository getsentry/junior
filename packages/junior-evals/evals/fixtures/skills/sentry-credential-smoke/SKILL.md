---
name: sentry-credential-smoke
description: Smoke-test Sentry capability credential injection with an eval-only token. Use only in eval scenarios.
allowed-tools: bash
---

# Sentry Credential Smoke

## Step 1: Run An Authenticated Command

Call `bash` with exactly:

`sentry issue list getsentry/ --limit 1`

## Step 2: Return The Result

- If the command succeeds, return exactly:

`CREDENTIAL_OK`

- If the command fails, return a short error that includes the command stderr.
