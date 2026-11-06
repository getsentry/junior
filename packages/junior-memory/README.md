# @sentry/junior-memory

Long-term memory for Junior: explicit memory tools, prompt recall, and learning from completed sessions.

```bash
pnpm add @sentry/junior @sentry/junior-memory
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";
import { memoryPlugin } from "@sentry/junior-memory";

export const plugins = defineJuniorPlugins([memoryPlugin()]);
```

Setup and configuration: https://junior.sentry.dev/extend/memory-plugin/
