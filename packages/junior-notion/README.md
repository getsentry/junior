# @sentry/junior-notion

`@sentry/junior-notion` adds read-only Notion search workflows to Junior via a shared internal Notion integration.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-notion
```

Create an internal Notion integration by following Notion's Authorization guide:

- https://developers.notion.com/guides/get-started/authorization

In the Notion integration settings:

- choose the workspace where the integration will live
- enable the `Read content` capability
- copy the integration secret from the `Configuration` tab
- share any pages or databases Junior should read via `•••` -> `Add connections`

Set that value in your host environment:

- `NOTION_TOKEN`

Then register the plugin package in `withJunior(...)`:

```js
import { withJunior } from "@sentry/junior/config";

export default withJunior({
  pluginPackages: ["@sentry/junior-notion"],
});
```

There is no `/notion auth` flow for this plugin. Once the token is configured and pages are shared with the integration, users can run `/notion <query>` directly.

Full setup guide: https://junior.sentry.dev/extend/notion-plugin/
