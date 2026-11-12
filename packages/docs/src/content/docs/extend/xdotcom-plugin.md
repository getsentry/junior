---
title: X Plugin
description: Configure read-only X (Twitter) lookups for post search, post lookup, replies, and user timelines.
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The X plugin lets Slack users ask Junior what people post on X about a topic, what an account posted recently, or what a linked post says. Junior calls the X API v2 from the sandbox.

The plugin is read-only. It uses one deployment-level app-only Bearer Token. X does not allow writes with app-only auth, so Junior cannot post, reply, like, repost, follow, or send DMs.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-xdotcom
```

## Runtime setup

Add the package name to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-xdotcom"]);
```

## Config

Set deployment variables in the Junior environment, then redeploy.

### Environment variables

<details class="plugin-config">
<summary><code>X_BEARER_TOKEN</code></summary>

X API app-only Bearer Token for read-only requests.

- **Define:** Set `X_BEARER_TOKEN` in the deployment environment
- **Required:** Yes
- **Environment override:** `X_BEARER_TOKEN`

Create an app in the [X Developer Console](https://console.x.com) and copy its **Bearer Token**. The console shows the token one time only.

</details>

## Billing

The X API is pay-per-use. There is no free read tier.

- X bills each post and user that a response returns against the app's prepaid credits.
- X bills the same resource one time per UTC day.
- Set a monthly spending limit in the X Developer Console. When the app reaches the limit, X blocks requests until the next billing cycle.
- The bundled skill keeps requests small: it asks for the minimum page size and does not page unless the user asks for more results.

See [X API pricing](https://docs.x.com/x-api/getting-started/pricing) for current rates.

## Auth model

- The plugin uses one deployment-level X app, not per-user OAuth.
- Junior keeps the real `X_BEARER_TOKEN` value on the host.
- Sandbox requests to `api.x.com` receive a host-managed `Authorization: Bearer <token>` header.
- The sandbox never receives the token in env, files, or command arguments.
- Users do not connect individual X accounts to Junior.

## What users can do

- Search recent posts (last 7 days) or the full archive.
- Count posts that match a query over time.
- Read a post from an `x.com` or `twitter.com` link, and read its replies.
- Look up an account by handle, and read its recent posts and mentions.

## Verify

1. Set `X_BEARER_TOKEN` and redeploy.
2. Ask Junior in a channel: `What has @XDevelopers posted this week?`
3. Confirm the reply summarizes recent posts and links each post on `x.com`.

## Failure modes

- `X_BEARER_TOKEN` missing or invalid: X returns `401 Unauthorized`. Set the env var and redeploy.
- `403 Forbidden`: the endpoint needs user context, or the account is protected.
- `429 Too Many Requests`: X is throttling, or the app has no credits left or reached its spending limit. Add credits or raise the limit in the X Developer Console.
- Write requests (post, like, follow, DM): app-only auth cannot do them, and the skill declines them.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
