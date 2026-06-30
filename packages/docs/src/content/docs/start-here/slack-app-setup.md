---
title: Slack App Setup
description: Configure Slack events, interactivity, slash commands, and App Home for a Junior deployment.
type: tutorial
summary: Create or update a Slack app so Junior can receive events and reply in threads.
prerequisites:
  - /start-here/quickstart/
related:
  - /start-here/deploy-to-vercel/
  - /start-here/verify-and-troubleshoot/
  - /concepts/thread-routing/
---

Junior receives Slack traffic at one webhook route:

```text
https://<your-domain>/api/webhooks/slack
```

Use your tunnel URL for local development and your Vercel URL for production.

## Create the Slack app

Create a Slack app in the workspace where users will talk to Junior, then add the signing secret and bot token to your Junior environment:

```bash
SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=xoxb-...
```

Use `SLACK_BOT_TOKEN` for normal bot replies. Use `SLACK_BOT_USER_TOKEN` only when your installation intentionally uses that token shape.

## Configure bot scopes

Grant the smallest scopes that cover the Slack features you enable. A typical Junior installation needs scopes for mentions, posting replies, reading thread context, reactions, user lookup, file workflows, and slash command handling.

| Capability                                         | Slack scopes to verify                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Mentions                                           | `app_mentions:read`                                                          |
| Thread replies and private auth prompts            | `chat:write`                                                                 |
| Processing reactions                               | `reactions:write`                                                            |
| User lookup and App Home ownership                 | `users:read`                                                                 |
| Slash command configured by `JUNIOR_SLASH_COMMAND` | `commands`                                                                   |
| Thread context in public/private channels and DMs  | `channels:history`, `groups:history`, `im:history`, `mpim:history` as needed |
| File/image context and generated files             | `files:read`, `files:write` when file workflows are enabled                  |
| Slack assistant status/title surfaces              | Assistant scopes required by your Slack app configuration                    |

Slack requires reinstalling the app after scope changes. Reinstall before debugging runtime behavior.

Also enable App Home in Slack app settings. Junior publishes the connected-account view when Slack sends `app_home_opened`.

## Subscribe to events

Set Event Subscriptions to the Junior webhook URL:

```text
https://<your-domain>/api/webhooks/slack
```

Subscribe to the events that match your usage:

| Event                         | Why Junior uses it                                   |
| ----------------------------- | ---------------------------------------------------- |
| `app_mention`                 | Channel and thread mentions.                         |
| `message.im`                  | Direct messages.                                     |
| `app_home_opened`             | Connected-account App Home view.                     |
| Slack assistant thread events | Assistant-thread title, status, and prompt surfaces. |

If your app relies on subscribed-thread follow-ups in shared channels, enable the channel message events required by that Slack app model and confirm the bot is present in those channels.

## Configure interactivity

Set the Interactivity request URL to the same webhook route:

```text
https://<your-domain>/api/webhooks/slack
```

Junior uses interactivity for App Home actions such as disconnecting provider accounts.

## Add the slash command

Create the slash command configured by `JUNIOR_SLASH_COMMAND` with this request URL. The default command is `/jr`:

```text
https://<your-domain>/api/webhooks/slack
```

Junior uses `<command> link` and `<command> unlink` for provider account management flows.

## Verify locally

For local development, expose your dev server with a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Then set Slack Event Subscriptions, Interactivity, and the configured slash command to the tunnel URL plus `/api/webhooks/slack`.

Verify the setup:

1. `GET http://localhost:3000/health` returns `status: "ok"`.
2. Mention Junior in a channel where the bot is installed.
3. Confirm Junior adds a processing reaction and posts a reply in the same thread.
4. Open App Home and confirm the connected-account view loads.

## Next step

After Slack works locally, follow [Deploy to Vercel](/start-here/deploy-to-vercel/) and update Slack URLs to your production domain.
