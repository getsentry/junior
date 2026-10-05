---
title: Hex Plugin
description: Configure the hosted Hex MCP server for data warehouse query workflows.
type: tutorial
prerequisites:
  - /extend/
related:
  - /concepts/credentials-and-oauth/
  - /operate/security-hardening/
---

The Hex plugin uses Hex's hosted MCP server so Slack users can run analytical queries against the data warehouse from Junior.

Junior exposes Hex's `create_thread` and `continue_thread` MCP tools. Its `waitForHexThread` tool polls `get_thread` without a model call for each poll.

Requires a Hex Team or Enterprise plan.

## Install

Install the plugin package alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-hex
```

## Runtime setup

Register the plugin in the plugin set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { hexPlugin } from "@sentry/junior-hex";

export const plugins = defineJuniorPlugins([hexPlugin()]);
```

## Auth model

- No `HEX_API_TOKEN` or shared secret is required.
- Each user completes OAuth the first time Junior calls a Hex MCP tool on their behalf.
- Junior sends the authorization link privately, then resumes the same thread automatically after the user authorizes.

## Config

### Environment variables

<details class="plugin-config">
<summary><code>HEX_MCP_URL</code></summary>

MCP endpoint for the Hex deployment this Junior instance uses.

- **Define:** Set `HEX_MCP_URL` in the deployment environment, then redeploy
- **Default:** `https://app.hex.tech/mcp`
- **Required:** No
- **Environment override:** `HEX_MCP_URL`

Common values are `https://eu.hex.tech/mcp` for EU, `https://hc.hex.tech/mcp` for HIPAA, and `https://your-company.hex.tech/mcp` for single-tenant deployments.

</details>

## Skills

The plugin ships one skill:

- **hex** — Creates a Hex thread, polls for completion, and extracts results against a caller-provided pattern.

## What users can do

- Query data from the Hex data warehouse using natural language or raw SQL.
- Get structured output suitable for downstream processing or display.

## Verify

Confirm a real user can connect and query successfully:

1. Ask Junior to check usage data for a known Sentry customer.
2. Complete the private OAuth flow when Junior prompts for it.
3. Confirm the thread resumes automatically and includes Hex query results.
4. Open Junior App Home and confirm Hex appears under `Connected accounts`.

## Failure modes

- No auth prompt or no resume: the user still needs to complete the OAuth flow. Retry the request and finish the private authorization flow when prompted.
- Query timeout: Hex threads can take time to process. The `hex` skill uses two bounded waits for up to ten polls. Complex queries may need to be simplified.
- No data returned: verify the entity identifier in the prompt matches what's in the warehouse. Narrow the query and try again.
- Wrong Hex workspace: verify `HEX_MCP_URL` points to the correct deployment if your org uses a custom Hex domain.

## Next step

Review [Credentials & OAuth](/concepts/credentials-and-oauth/) and [Security Hardening](/operate/security-hardening/).
