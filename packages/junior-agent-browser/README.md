# @sentry/junior-agent-browser

`@sentry/junior-agent-browser` adds browser automation workflows to Junior via the `agent-browser` CLI.

Install it alongside `@sentry/junior`:

```bash
pnpm add @sentry/junior @sentry/junior-agent-browser
```

Add the package name to the shared plugin set passed to both `juniorNitro()`
and `createApp()`:

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-agent-browser"]);
```

Full setup guide: https://junior.sentry.dev/extend/agent-browser-plugin/
