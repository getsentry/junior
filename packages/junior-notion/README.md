# @sentry/junior-notion

`@sentry/junior-notion` adds read-only Notion search workflows to Junior via per-user OAuth.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-notion
```

Create a public Notion integration by following Notion's Authorization guide:

- https://developers.notion.com/guides/get-started/authorization

In the Notion integration settings:

- choose `Public` as the integration type
- set the redirect URI to `<base-url>/api/oauth/callback/notion`
- enable the `Read content` capability
- copy the client ID and client secret from the `Configuration` tab

Set those values in your host environment:

- `NOTION_CLIENT_ID`
- `NOTION_CLIENT_SECRET`

Then register the plugin package in `withJunior(...)`:

```js
import { withJunior } from "@sentry/junior/config";

export default withJunior({
  pluginPackages: ["@sentry/junior-notion"],
});
```

Full setup guide: https://junior.sentry.dev/extend/notion-plugin/
