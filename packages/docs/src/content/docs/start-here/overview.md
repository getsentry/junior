---
title: Overview
description: How Junior fits together and which setup path to follow first.
type: conceptual
summary: Choose the right path through setup, extension, and operations docs.
prerequisites: []
related:
  - /start-here/quickstart/
  - /start-here/using-junior/
  - /concepts/security-and-authority/
  - /start-here/slack-app-setup/
  - /extend/
---

Junior is a Slack bot for teams that want to use company tools from Slack threads. A Junior app receives Slack events and runs turns with its tools and skills. It posts final replies to the original thread.

## Main parts

Junior apps are small Hono apps that use Nitro to build and deploy. `createApp()` owns the public routes. `juniorNitro()` adds app files and declared plugin packages to the deployed app.

| Layer      | What it controls                                                                         |
| ---------- | ---------------------------------------------------------------------------------------- |
| Slack app  | Events, interactivity, app home, slash commands, and bot token permissions.              |
| Junior app | Runtime routes, queue-backed turns, state, and reply delivery.                           |
| App files  | `SOUL.md`, `WORLD.md`, `DESCRIPTION.md`, local skills, and local plugins.                |
| Plugins    | Provider manifests, credentials, MCP surfaces, runtime dependencies, and bundled skills. |
| Operators  | Env vars, Vercel deployment, observability, recovery, and security posture.              |

The recommended first app path is `junior init`, then Slack setup, then Vercel deploy.

## Reading Path

| Goal                                   | Start with                                                    |
| -------------------------------------- | ------------------------------------------------------------- |
| Work with Junior in Slack              | [Using Junior](/start-here/using-junior/)                     |
| Create a new app                       | [Quickstart](/start-here/quickstart/)                         |
| Configure Slack events and permissions | [Slack App Setup](/start-here/slack-app-setup/)               |
| Deploy the scaffolded app              | [Deploy to Vercel](/start-here/deploy-to-vercel/)             |
| Add Junior to an existing host         | [Existing App](/start-here/existing-app/)                     |
| Add provider integrations              | [Plugins](/extend/)                                           |
| Debug a live deployment                | [Verify & Troubleshoot](/start-here/verify-and-troubleshoot/) |

## What to Configure First

Set up only the core app before you add provider plugins. This limits early failures to the health route, Slack webhook, queue callback, and one thread reply.

After that baseline works, add one plugin at a time. Each plugin page lists its env vars, auth model, verification request, and failure modes.

## Next step

Use [Quickstart](/start-here/quickstart/) to create the app, then continue to [Slack App Setup](/start-here/slack-app-setup/).
