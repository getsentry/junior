---
title: "junior chat"
description: "Run a local Junior conversation without Slack."
type: reference
summary: Test Junior agent behavior from a local terminal conversation.
prerequisites:
  - /start-here/quickstart/
related:
  - /contribute/local-agent-validation/
  - /reference/config-and-env/
  - /cli/check/
  - /operate/observability/
---

Use `junior chat` when you want to exercise Junior's agent runtime without sending a Slack message. The command runs from a project that already has `@sentry/junior` installed and uses the same app files, skills, plugins, model settings, and sandbox behavior as a normal agent turn. For a focused validation workflow, use [Local Agent Validation](/contribute/local-agent-validation/).

## Usage

Start an interactive local conversation:

```bash
pnpm exec junior chat
```

Send one message and exit:

```bash
pnpm exec junior chat -p "Summarize this repository"
```

## Options

| Option         | Purpose                                            |
| -------------- | -------------------------------------------------- |
| `-p <message>` | Sends one message, prints the response, and exits. |

Every `junior chat` invocation creates a fresh local conversation. Interactive mode keeps context only while that process is running; `-p` sends one isolated message and exits.

## State and environment

`junior chat` does not require Slack request signing, Slack tokens, or a Slack channel. It still needs the model and tool environment required by the behavior you are testing, such as `AI_GATEWAY_API_KEY` or plugin provider credentials.

When neither `JUNIOR_STATE_ADAPTER` nor `REDIS_URL` is set, the command uses the in-memory state adapter so a new project can start a local session without Redis. Set `REDIS_URL` when you want local run state stored for diagnostics or to match your deployed app state behavior; the CLI still starts a new conversation on each invocation.

The local actor is the `local-cli` system actor. Provider OAuth prompts are disabled for this local command, so tests that require user-bound provider credentials should use already configured credentials or a deployed Slack flow.

## Verification

1. Run `pnpm exec junior check` from the app root.
2. Run `pnpm exec junior chat -p "Say hello in one sentence"`.
3. Confirm the command prints a Junior response and exits with status `0`.
4. If the command reports missing model or provider credentials, add the required environment variables and retry.

## Next step

Use [Config & Environment](/reference/config-and-env/) to configure model and provider credentials, then use [Observability](/operate/observability/) when local turns need tracing or log inspection.
