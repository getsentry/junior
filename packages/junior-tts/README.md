# @sentry/junior-tts

Gemini narration for Junior through Vercel AI Gateway, with a reusable Junior voice preset.

```bash
pnpm add @sentry/junior @sentry/junior-tts
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-tts"]);
```

Setup and configuration: https://junior.sentry.dev/extend/tts-plugin/
