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

Use `junior chat` to test Junior without sending a Slack message. Run the command from a project that has `@sentry/junior` installed. It uses the same app files, skills, plugins, model settings, and sandbox behavior as a normal turn. For a focused test, use [Local Agent Validation](/contribute/local-agent-validation/).

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

Each `junior chat` command creates a new local conversation. Interactive mode keeps context only while the process runs. The `-p` option sends one separate message and exits.

## State and environment

`junior chat` does not require Slack request signing, Slack tokens, or a Slack channel. It still needs the model and tool environment required by the behavior you are testing, such as Vercel OIDC (`vercel env pull`) or `AI_GATEWAY_API_KEY`, plus any plugin provider credentials.

If `JUNIOR_STATE_ADAPTER` and `REDIS_URL` are not set, the command keeps state in memory. This lets a new project start without Redis. Set `REDIS_URL` to save local run state or to match the deployed app. The CLI still starts a new conversation for each command.

The local actor is the `local-cli` user. When a provider needs user OAuth, the command prints the authorization link, waits for the browser callback, and then continues the same request. Keep the command running while you authorize. The public development URL and local dev server must be reachable for this relay; see [Local Agent Validation](/contribute/local-agent-validation/) for the setup and troubleshooting steps.

## Verification

1. Run `pnpm exec junior check` from the app root.
2. Run `pnpm exec junior chat -p "Say hello in one sentence"`.
3. Confirm the command prints a Junior response and exits with status `0`.
4. If the command reports missing model or provider credentials, add the required environment variables and retry.

## Next step

Use [Config & Environment](/reference/config-and-env/) to configure model and provider credentials, then use [Observability](/operate/observability/) when local turns need tracing or log inspection.
