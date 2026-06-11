---
title: Local Agent Validation
description: Use junior chat to validate non-Slack behavior from a terminal.
type: tutorial
summary: Verify agent behavior locally before using Slack-specific test paths.
prerequisites:
  - /contribute/development/
  - /cli/chat/
related:
  - /contribute/testing/
  - /cli/check/
  - /start-here/verify-and-troubleshoot/
---

Use this runbook for product, runtime, prompt, skill, plugin, tool, sandbox, or
credential changes that are not specifically about Slack ingress, Slack message
formatting, Slack retries, or Slack OAuth UI. The local agent should be the
first manual behavior check for those changes.

## First Check

Confirm the app is configured:

```bash
pnpm exec junior check
```

When you are working inside this monorepo, use the source CLI wrapper instead:

```bash
pnpm cli -- check
```

Run one local turn:

```bash
pnpm exec junior chat --once "Describe the behavior I just changed in one sentence."
```

From this monorepo, run the same check through the source CLI:

```bash
pnpm cli -- chat --once "Describe the behavior I just changed in one sentence."
```

The command should print a Junior response and exit with status `0`. If it
reports missing model or provider credentials, refresh or add the required
environment variables and rerun the same prompt.

## Conversation Check

Use a named conversation when the change depends on context across turns:

```bash
pnpm exec junior chat --conversation validation
```

From this monorepo:

```bash
pnpm cli -- chat --conversation validation
```

Send two prompts that exercise the changed behavior, then type `/exit`. The
second response should use context from the first response without needing a
Slack channel or thread.

## What This Proves

Local validation proves that the shared agent path can run without Slack:

- the prompt reaches the agent runtime
- the local destination is not Slack-shaped
- tools and plugins run with the configured local environment
- visible conversation context survives within the selected local conversation
- terminal delivery succeeds for text replies

Keep the usual focused tests for deterministic contracts. Use Slack-specific
tests only when the change is about Slack event routing, Slack outbound payloads,
Slack markdown, Slack files, Slack retry behavior, or Slack authorization UI.

## Failure Checks

If local validation fails, use the first matching symptom:

| Symptom                         | First check                                                      |
| ------------------------------- | ---------------------------------------------------------------- |
| Missing model credentials       | Refresh env with `pnpm dev:env`, then rerun the same prompt.     |
| Missing provider credentials    | Configure the plugin/provider env required by the changed path.  |
| State does not persist          | Set `REDIS_URL`; memory state is process-local.                  |
| Generated files fail delivery   | Expected in the first local adapter; validate file UX elsewhere. |
| Slack-specific behavior changed | Use the Slack specs and Slack integration tests instead.         |

## Next Step

After local behavior works, run the focused commands from
[Testing](/contribute/testing/) for the files you changed.
