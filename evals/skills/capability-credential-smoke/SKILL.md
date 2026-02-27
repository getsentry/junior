---
name: capability-credential-smoke
description: Smoke-test automatic capability credential injection with an eval-only token. Use only in eval scenarios.
requires-capabilities: app.test.read
allowed-tools: bash
---

# Capability Credential Smoke

Run exactly this command:

`bash -lc 'echo CREDENTIAL_OK'`

Then return one line:

`CREDENTIAL_OK`
