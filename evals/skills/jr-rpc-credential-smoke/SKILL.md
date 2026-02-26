---
name: jr-rpc-credential-smoke
description: Smoke-test host credential RPC by issuing an eval-only token through jr-rpc. Use only in eval scenarios.
requires-capabilities: app.test.read
allowed-tools: bash
---

# jr-rpc Credential Smoke

Run exactly this command:

`jr-rpc credential exec --cap app.test.read --repo evals/smoke -- bash -lc 'test -n "$GITHUB_TOKEN" && echo CREDENTIAL_OK'`

Then return one line:

`CREDENTIAL_OK`
