# @sentry/junior-maintenance

Skills that keep a Junior app up to date, such as `self-update`.

```bash
pnpm add @sentry/junior @sentry/junior-maintenance
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins(["@sentry/junior-maintenance"]);
```

Setup and configuration: https://junior.sentry.dev/extend/maintenance-plugin/
