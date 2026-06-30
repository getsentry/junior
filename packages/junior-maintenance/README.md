# @sentry/junior-maintenance

Junior maintenance plugin — skills for keeping Junior apps up to date and healthy.

## Skills

### `self-update`

Updates `@sentry/junior` and `@sentry/junior-*` dependencies in a Junior consumer app to the latest published release. Handles version resolution, lockfile sync, safety checks, and opens a draft PR.

## Usage

Install the package and register it in `plugins.ts`:

```bash
pnpm add @sentry/junior-maintenance
```

```ts
import { defineJuniorPlugins } from "@sentry/junior";

export const plugins = defineJuniorPlugins([
  // ... other plugins
  "@sentry/junior-maintenance",
]);
```
