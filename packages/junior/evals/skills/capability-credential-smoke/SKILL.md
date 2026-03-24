---
name: capability-credential-smoke
description: Smoke-test automatic capability credential injection with an eval-only token. Use only in eval scenarios.
requires-capabilities: github.issues.read
allowed-tools: bash
---

# Capability Credential Smoke

## Step 1: Enable The Credential

Call `bash` with exactly:

`jr-rpc issue-credential github.issues.read --repo getsentry/junior`

## Step 2: Return The Result

- If the command succeeds, return exactly:

`CREDENTIAL_OK`

- If the command fails, return a short error that includes the command stderr.
