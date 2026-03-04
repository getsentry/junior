---
name: capability-credential-smoke
description: Smoke-test automatic capability credential injection with an eval-only token. Use only in eval scenarios.
requires-capabilities: github.issues.read
allowed-tools: bash
---

# Capability Credential Smoke

Run exactly this command:

`jr-rpc issue-credential github.issues.read --repo getsentry/junior`

Then return one line:

`CREDENTIAL_OK`
