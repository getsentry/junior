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
environment-backed credential changes that are not specifically about Slack
ingress, Slack message formatting, Slack retries, or Slack OAuth UI. The local
agent should be the first manual behavior check for those changes.

Inside this monorepo, `pnpm cli -- ...` runs Junior from `apps/example`. Treat
that app as the canonical local validation app: it loads the example SOUL,
WORLD, local skills, plugin-bundled skills, and normal development env without
requiring Slack.

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
pnpm exec junior chat -p "Describe the behavior I just changed in one sentence."
```

From this monorepo, run the same check through the source CLI:

```bash
pnpm cli -- chat -p "Describe the behavior I just changed in one sentence."
```

The command should print a Junior response and exit with status `0`. If it
reports missing model or provider credentials, refresh or add the required
environment variables and rerun the same prompt.

`-p` uses a fresh local conversation for each invocation. Use interactive mode
when you need to validate multi-turn context.

## Example App Checks

Use the example app skills when you need to prove local skill and plugin
discovery, not just a plain model response:

```bash
pnpm cli -- chat -p "/example-local Confirm the example app local skill is available."
```

```bash
pnpm cli -- chat -p "/example-bundle-help Explain where this plugin-bundled skill is discovered from and whether it supports jr-rpc issue-credential."
```

The first command should use the app-local `example-local` skill. The second
should report that the skill is discovered from
`app/plugins/example-bundle/skills` and that `example-bundle` is bundle-only
without credential issuance support.

## Conversation Check

Use interactive mode when the change depends on context across turns:

```bash
pnpm exec junior chat
```

From this monorepo:

```bash
pnpm cli -- chat
```

Send two prompts that exercise the changed behavior, then type `/exit`. The
second response should use context from the first response without needing a
Slack channel or thread.

## What This Proves

Local validation proves that the shared agent path can run without Slack:

- the prompt reaches the agent runtime
- the local destination is not Slack-shaped
- tools and plugins run with the configured local environment
- visible conversation context survives within one interactive local process
- terminal delivery succeeds for text replies

Keep the usual focused tests for deterministic contracts. Use Slack-specific
tests only when the change is about Slack event routing, Slack outbound payloads,
Slack markdown, Slack files, Slack retry behavior, or Slack authorization UI.
User-bound OAuth and credential issuance flows are not validated by local chat
because the local agent runs as the `local-cli` system actor with authorization
prompts disabled.

## Failure Checks

If local validation fails, use the first matching symptom:

| Symptom                         | First check                                                                 |
| ------------------------------- | --------------------------------------------------------------------------- |
| Missing model credentials       | Refresh env with `pnpm dev:env`, then rerun the same prompt.                |
| Missing provider credentials    | Configure the plugin/provider env required by the changed path.             |
| Context resets between commands | Expected; use one interactive `junior chat` process for context.            |
| File-send UX needs validation   | Local validation cannot verify it; the local adapter has no file-send tool. |
| Slack-specific behavior changed | Use the Slack adapter README, Slack skill, and integration tests instead.   |

## Next Step

After local behavior works, run the focused commands from
[Testing](/contribute/testing/) for the files you changed.
