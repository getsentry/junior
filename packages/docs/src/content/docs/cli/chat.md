---
title: "junior chat"
description: "Run a local Junior conversation without Slack."
type: reference
summary: Test Junior agent behavior from a local terminal conversation.
prerequisites:
  - /start-here/quickstart/
related:
  - /reference/config-and-env/
  - /cli/check/
  - /operate/observability/
---

Use `junior chat` when you want to exercise Junior's agent runtime without sending a Slack message. The command runs from a project that already has `@sentry/junior` installed and uses the same app files, skills, plugins, model settings, and sandbox behavior as a normal agent turn.

## Usage

Start an interactive local conversation:

```bash
pnpm exec junior chat
```

Send one message and exit:

```bash
pnpm exec junior chat --once "Summarize this repository"
```

Name a local conversation when you want to keep separate threads:

```bash
pnpm exec junior chat --conversation docs-review
```

## Options

| Option                  | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `--once <message>`      | Sends one message, prints the response, and exits.            |
| `--conversation <name>` | Uses a stable local conversation name. Defaults to `default`. |

Conversation names may contain letters, numbers, dots, underscores, and hyphens. Junior scopes local conversation ids to the current working directory, so the same name in two projects does not collide.

## State and environment

`junior chat` does not require Slack request signing, Slack tokens, or a Slack channel. It still needs the model and tool environment required by the behavior you are testing, such as `AI_GATEWAY_API_KEY` or plugin provider credentials.

When neither `JUNIOR_STATE_ADAPTER` nor `REDIS_URL` is set, the command uses the in-memory state adapter so a new project can start a local session without Redis. Set `REDIS_URL` when you want conversation state to survive process restarts or match your deployed app state behavior.

The local actor is the `local-cli` system actor. Provider OAuth prompts are disabled for this local command, so tests that require user-bound provider credentials should use already configured credentials or a deployed Slack flow.

## Verification

1. Run `pnpm exec junior check` from the app root.
2. Run `pnpm exec junior chat --once "Say hello in one sentence"`.
3. Confirm the command prints a Junior response and exits with status `0`.
4. If the command reports missing model or provider credentials, add the required environment variables and retry.

## Next step

Use [Config & Environment](/reference/config-and-env/) to configure model and provider credentials, then use [Observability](/operate/observability/) when local turns need tracing or log inspection.
