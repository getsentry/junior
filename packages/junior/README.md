# @sentry/junior

`@sentry/junior` is a Slack bot package for Next.js apps.

## Install

```bash
pnpm add @sentry/junior
pnpm add next react react-dom @sentry/nextjs
```

## Quick usage

`app/api/[...path]/route.js`:

```js
export { GET, POST } from "@sentry/junior/handler";
export const runtime = "nodejs";
```

`app/api/queue/callback/route.js`:

```js
export { POST } from "@sentry/junior/handlers/queue-callback";
export const runtime = "nodejs";
```

`next.config.mjs`:

```js
import { withJunior } from "@sentry/junior/config";

export default withJunior({
  pluginPackages: [
    "@sentry/junior-github",
    "@sentry/junior-notion",
    "@sentry/junior-sentry",
  ],
});
```

## Full docs

Canonical docs: **https://junior.sentry.dev/**

- Quickstart: https://junior.sentry.dev/start-here/quickstart/
- Deployment: https://junior.sentry.dev/start-here/deploy/
- Plugin setup: https://junior.sentry.dev/extend/plugins-overview/
- API reference: https://junior.sentry.dev/reference/api/
