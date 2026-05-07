---
name: capability-credential-smoke
description: Smoke-test automatic capability credential injection with an eval-only token. Use only in eval scenarios.
allowed-tools: bash
---

# Capability Credential Smoke

## Step 1: Run An Authenticated Command

Call `bash` with exactly:

`gh issue view 1 --repo getsentry/junior`

## Step 2: Return The Result

- If the command succeeds, return exactly:

`CREDENTIAL_OK`

- If the command fails, return a short error that includes the command stderr.
