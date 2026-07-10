# `@sentry/junior-amplitude`

Read-only Amplitude product analytics for Junior through Amplitude's hosted MCP server.

## Install

```bash
pnpm add @sentry/junior @sentry/junior-amplitude
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-amplitude"]);
```

Junior starts Amplitude's per-user OAuth flow when the agent first needs Amplitude data. The plugin exposes a fixed allowlist of Amplitude's documented search, retrieval, list, and query tools across analytics, taxonomy, session replay, experiments, feature flags, cohorts, guides and surveys, feedback, and agent analytics. Rendering, creation, editing, update, sync, merge, and deletion tools are not available to the agent.

The default MCP endpoint is `https://mcp.amplitude.com/mcp`. Set `AMPLITUDE_MCP_URL` to the regional endpoint documented by Amplitude when the deployment uses another data region.

Full setup guide: https://junior.sentry.dev/extend/amplitude-plugin/
