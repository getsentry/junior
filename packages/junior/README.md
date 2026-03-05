# @sentry/junior

`@sentry/junior` is a Slack bot package for Next.js apps.

If you are contributing to this monorepo, use the root docs:

- `README.md` for general usage
- `CONTRIBUTING.md` for development workflows

## Install

```bash
pnpm add @sentry/junior
pnpm add next react react-dom @sentry/nextjs
```

## Required App Files

Add these files under `app/`:

```text
app/SOUL.md
app/ABOUT.md
app/skills/
app/plugins/ (optional)
```

## Next.js Integration

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
export default withJunior();
```

`instrumentation.js`:

```js
export { register, onRequestError } from "@sentry/junior/instrumentation";
```

If your app does not already include a root layout:

`app/layout.js`:

```js
export { default } from "@sentry/junior/app/layout";
```

## Scaffold a New Bot

```bash
npx junior init my-bot
cd my-bot
pnpm install
pnpm dev
```

## Vercel Queue Trigger

Add this `vercel.json` function trigger:

```json
{
  "functions": {
    "app/api/queue/callback/route.js": {
      "experimentalTriggers": [
        {
          "type": "queue/v2beta",
          "topic": "junior-thread-message"
        }
      ]
    }
  }
}
```
