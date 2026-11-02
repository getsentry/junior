# @sentry/junior-pagerduty

Read-only PagerDuty on-call, schedule, and incident lookups for Junior through the PagerDuty REST API.

```bash
pnpm add @sentry/junior @sentry/junior-pagerduty
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-pagerduty"]);
```

Setup and configuration: https://junior.sentry.dev/extend/pagerduty-plugin/
