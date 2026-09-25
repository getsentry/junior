# @sentry/junior-maintenance

Junior maintenance plugin — skills for keeping Junior apps up to date and healthy.

## Skills

### `self-update`

Updates junior-prod to a verified GitHub Release using the app's `junior:update` and `deps:install` commands. Reviews release notes and app config, runs checks, and opens a draft PR. The app must have the GitHub release install scripts and a pinned `junior-release.json`; the skill does not fall back to npm.

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
