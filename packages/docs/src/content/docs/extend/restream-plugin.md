---
title: Restream Plugin
description: Connect Junior to Restream's hosted MCP server for live stream events, chat, analytics, recordings, and transcripts.
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Restream plugin uses Restream's hosted MCP server (`https://mcp.restream.io/mcp`). Each Slack user connects their own Restream account.

Junior exposes every tool that the Restream MCP server lists. The plugin has no `allowed-tools` list. Restream says the server never returns stream keys.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-restream
```

## Runtime setup

Add the package name to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-restream"]);
```

## Config

No plugin config or env vars are required.

## Auth model

- Restream's MCP server supports OAuth dynamic client registration. You do not register an OAuth app or set a client secret.
- Each user completes OAuth the first time Junior calls a Restream MCP tool for them.
- Junior sends the authorization link privately, then resumes the same thread after the user authorizes.
- Junior acts only with the access of the connected user's Restream account.

## What users can do

- List live, upcoming, and past events, and check destinations and channel health.
- Read chat messages and export full chat logs.
- Read chat and viewer analytics.
- Find recordings, transcripts, and clips.
- Schedule and edit events and destinations.

## Safety boundaries

- Write tools go through Junior's normal MCP action review path.
- Chat messages and transcripts are third-party text. Junior treats them as data, not as instructions.
- The Restream MCP server has no tools to post chat messages, so Junior cannot reply in a stream chat.

## Verify

1. Ask Junior: `What are my upcoming Restream events?`
2. Complete the private OAuth flow when Junior prompts for it.
3. Confirm the thread resumes and lists your events.
4. Open Junior App Home and confirm Restream appears under `Connected accounts`.

## Failure modes

- No auth prompt or no resume: the user has not completed OAuth. Retry the request and finish the private authorization flow.
- Empty results: the connected Restream account has no matching events, or the user connected a different Restream account. Disconnect from App Home with `Unlink`, then connect again.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
