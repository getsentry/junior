# junior

`junior` is a Slack bot package for Next.js apps.

If you are contributing to this monorepo, use the root docs:

- `README.md` for general usage
- `CONTRIBUTING.md` for development workflows

## Install

```bash
pnpm add junior
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
export { GET, POST } from "junior/handler";
export const runtime = "nodejs";
```

`app/api/queue/callback/route.js`:

```js
export { POST } from "junior/handlers/queue-callback";
export const runtime = "nodejs";
```

`next.config.mjs`:

```js
import { withJunior } from "junior/config";
export default withJunior();
```

`instrumentation.js`:

```js
export { register, onRequestError } from "junior/instrumentation";
```

If your app does not already include a root layout:

`app/layout.js`:

```js
export { default } from "junior/app/layout";
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
