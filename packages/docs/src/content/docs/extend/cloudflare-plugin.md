---
title: Cloudflare Plugin
description: Configure the Cloudflare API MCP server for Workers monitoring, deployments, builds, logs, DNS, and production operations.
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Cloudflare plugin uses Cloudflare's hosted API MCP server so Slack users can investigate Workers errors, check build and deployment status, inspect DNS records, query logs, check load balancer pool health, review Zero Trust tunnels, and manage Cloudflare resources from their own account context.

Junior connects to the hosted MCP server declared by the plugin. Cloudflare OAuth or API token permissions determine which Cloudflare operations are available; the Junior plugin does not maintain an API allowlist.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-cloudflare
```

## Runtime setup

Add the package name to the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-cloudflare"]);
```

## Auth model

- No static `CLOUDFLARE_API_TOKEN` or shared account credential is required for the default setup.
- Each user completes Cloudflare's MCP OAuth flow the first time Junior calls a Cloudflare MCP tool on their behalf.
- Junior sends the authorization link privately, then resumes the same thread automatically after the user authorizes.
- The plugin is optimized for interactive user-driven work in Slack.

## Config

Set conversation config with `jr-rpc config set`, or define the same keys for every conversation with `createApp({ configDefaults })`. An explicit account, zone, or Worker in a request always wins.

<details class="plugin-config">
<summary><code>cloudflare.account.id</code></summary>

Default Cloudflare account when a request does not identify one.

- **Define:** `jr-rpc config set cloudflare.account.id <account_id>`
- **Install-wide default:** `configDefaults["cloudflare.account.id"]`
- **Required:** No; Junior can discover it with Account Resources: Read
- **Environment override:** None

</details>

<details class="plugin-config">
<summary><code>cloudflare.zone.id</code></summary>

Default Cloudflare zone when a request does not identify one.

- **Define:** `jr-rpc config set cloudflare.zone.id <zone_id>`
- **Install-wide default:** `configDefaults["cloudflare.zone.id"]`
- **Required:** No
- **Environment override:** None

</details>

<details class="plugin-config">
<summary><code>cloudflare.worker.name</code></summary>

Default Worker for requests such as “check the latest errors” or “show the recent deploy.”

- **Define:** `jr-rpc config set cloudflare.worker.name <worker_name>`
- **Install-wide default:** `configDefaults["cloudflare.worker.name"]`
- **Required:** No
- **Environment override:** None

</details>

## What users can do

- Investigate Workers errors, error rates, and CPU performance.
- Check Workers Build CI status and review build logs.
- Tail live Worker logs or query Workers analytics.
- Inspect DNS records and proxy status for a zone.
- Check load balancer pool and origin health.
- Review Logpush job delivery health.
- Inspect Zero Trust tunnel status and connections.
- Audit recent configuration changes from the account audit log.
- Deploy a Worker version or prepare a rollback (with confirmation).
- Make DNS record changes (with confirmation and current-state diff).

## Required API token permissions

When Cloudflare's OAuth does not grant sufficient scope for a task, create a Cloudflare API token with the minimum permissions needed:

| Task                     | Token permissions                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------- |
| Read-only monitoring     | Account Resources: Read, Zone: Read, Workers Scripts: Read, Logs: Read, Analytics: Read |
| Worker deploy / rollback | Workers Scripts: Edit                                                                   |
| DNS management           | DNS: Edit, Zone: Read                                                                   |
| Load balancer management | Load Balancers: Edit, Zone: Read                                                        |
| Zero Trust inspection    | Access: Read                                                                            |

Tokens with Client IP Address Filtering enabled are not currently supported by the Cloudflare MCP server.

## Verify

Confirm a real user can connect and query Cloudflare successfully:

1. Ask Junior to list the Workers scripts in your Cloudflare account.
2. Complete the private OAuth flow when Junior prompts for it.
3. Confirm the thread resumes automatically with the Workers list.
4. Open Junior App Home and confirm Cloudflare appears under `Connected accounts`.

## Failure modes

- **Auth error or 401**: The user's session is not authorized. Retry the request to trigger the OAuth flow again.
- **403 permission denied**: The authorized account lacks the required Cloudflare permission for this resource. Check the token permissions table above.
- **Account not found**: Auto-discovery failed because the token lacks Account Resources: Read. Set `cloudflare.account.id` explicitly.
- **Multiple accounts found**: The token has access to more than one account. Junior will ask the user to specify; set `cloudflare.account.id` to avoid the prompt.
- **Analytics delayed**: Cloudflare analytics pipelines typically lag by 1–2 minutes. Use live tail logs for real-time error investigation.
- **Build logs unavailable**: Workers Builds log access may require specific plan or token permissions.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
