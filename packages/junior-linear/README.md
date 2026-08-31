# @sentry/junior-linear

`@sentry/junior-linear` adds Linear issue workflows to Junior through Linear's hosted MCP server.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-linear
```

Then add the plugin to the set exported from `plugins.ts`:

```ts title="plugins.ts"
import { defineJuniorPlugins } from "@sentry/junior";
import { linearPlugin } from "@sentry/junior-linear";

export const plugins = defineJuniorPlugins([linearPlugin()]);
```

This package does not require a shared `LINEAR_API_KEY` or a custom OAuth app for the default setup. Each user connects their own Linear account the first time Junior calls a Linear MCP tool. Junior sends the authorization link privately and resumes the same Slack thread automatically after the user authorizes.

Linear operations use Linear's hosted MCP tools directly. When an issue is created through that path, Junior links it to the current conversation.

To run watches or event tasks when Linear issues are created:

1. Set `LINEAR_WEBHOOK_SECRET` to the Linear webhook signing secret.
2. Create a Linear webhook for the `Issue` resource at `https://<junior-host>/api/webhooks/linear`.
3. Redeploy Junior.

The plugin verifies the `Linear-Signature` header and publishes `issue.created` for the issue identifier and the team key. Team event tasks use the Linear team key, such as `SRE`. Issue and team watches also accept an optional `match.teamKey` filter on trusted event data.

Optional: set channel defaults when a Slack thread usually routes work to the same Linear destination:

```bash
jr-rpc config set linear.team Platform
jr-rpc config set linear.project "Cross-team reliability"
```

These defaults are only fallbacks. If the user names a different team or project in the request, Junior should follow the explicit request instead.

Full setup guide: https://junior.sentry.dev/extend/linear-plugin/
