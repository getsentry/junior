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

Use this runbook for changes to the product, runtime, prompts, skills, plugins,
tools, sandbox, or credentials. Do not use it first for Slack input, message
format, retries, or OAuth screens. For all other changes, test the local agent
first.

In this monorepo, `pnpm cli -- ...` runs Junior from `apps/example`. Use this
app for local tests. It loads the example SOUL, WORLD, local skills, plugin
skills, and normal development environment. It does not require Slack.

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

`-p` uses a new local conversation for each command. Use interactive mode to
test context across turns.

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
Local chat can validate user-bound OAuth and credential issuance: it prints the
private authorization URL, waits for the callback, and resumes the same turn as
the `local-cli` user.

Keep `pnpm dev` running for OAuth checks. The configured public callback reaches
the dev server first, which verifies the signed local state and redirects the
browser to the CLI's loopback listener.

## Failure Checks

If local validation fails, use the first matching symptom:

| Symptom                         | First check                                                                 |
| ------------------------------- | --------------------------------------------------------------------------- |
| Missing model credentials       | Refresh env with `pnpm dev:env`, then rerun the same prompt.                |
| Missing provider credentials    | Configure the plugin/provider env required by the changed path.             |
| OAuth callback cannot connect   | Keep `pnpm dev` and its configured tunnel running while the CLI waits.      |
| Context resets between commands | Expected; use one interactive `junior chat` process for context.            |
| File-send UX needs validation   | Local validation cannot verify it; the local adapter has no file-send tool. |
| Slack-specific behavior changed | Use the Slack adapter README, Slack skill, and integration tests instead.   |

## Next Step

After local behavior works, run the focused commands from
[Testing](/contribute/testing/) for the files you changed.
