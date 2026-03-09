# @sentry/junior-notion

`@sentry/junior-notion` adds read-only Notion search workflows to Junior via per-user OAuth.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-notion
```

Set host env vars:

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
