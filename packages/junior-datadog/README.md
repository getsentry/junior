# @sentry/junior-datadog

Read-only Datadog telemetry for Junior through Datadog's Pup CLI.

```bash
pnpm add @sentry/junior @sentry/junior-datadog
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-datadog"]);
```

Setup and configuration: https://junior.sentry.dev/extend/datadog-plugin/
