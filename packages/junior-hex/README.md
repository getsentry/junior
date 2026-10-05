# @sentry/junior-hex

`@sentry/junior-hex` adds Hex data warehouse query workflows to Junior through Hex's hosted MCP server.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-hex
```

## Configure

Register the Hex plugin in the plugin set exported from `plugins.ts`:

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { hexPlugin } from "@sentry/junior-hex";

export const plugins = defineJuniorPlugins([hexPlugin()]);
```

No API token is needed. Each user completes OAuth the first time Junior calls a Hex MCP tool on their behalf.

For non-standard Hex deployments, set `HEX_MCP_URL` in your environment:

- Single-tenant: `https://your-company.hex.tech/mcp`
- EU multi-tenant: `https://eu.hex.tech/mcp`
- HIPAA: `https://hc.hex.tech/mcp`

Requires a Hex Team or Enterprise plan.

The `waitForHexThread` tool polls Hex up to five times per call. A second call
can continue the wait without another model request for each poll.
